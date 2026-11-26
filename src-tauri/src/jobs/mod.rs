//! Jobs de processo em background do harness de código (Fase F4).
//!
//! Um job é uma execução de shell que continua viva depois que a tool retorna.
//! O [`JobRegistry`] é dono do ciclo de vida (spawn, ring buffer de saída,
//! cancelamento, limites) e emite [`crate::events::TurnEvent::JobUpdated`] na
//! abertura e no fechamento; as tools `job_list`/`job_output`/`job_kill` e os
//! comandos `list_jobs`/`get_job_output`/`kill_job` leem o mesmo estado.
//!
//! Contrato: `docs/goals/code-harness/TOOLS.md` §2.3 e `HARNESS.md` §12.
//!
//! Regras:
//! - jobs são **process-locais** (morrem com o app; documentado);
//! - até [`MAX_CONCURRENT_JOBS_PER_CONVERSATION`] jobs vivos por sessão;
//! - a saída fica num ring buffer de [`RING_CAPACITY_BYTES`] e é lida por cursor
//!   absoluto (nunca "some" silenciosamente: o cursor avança);
//! - cancelar o turno **não** mata jobs (comportamento DSH: trabalho longo
//!   sobrevive ao turno); apenas `job_kill`/`cancel_all`/fim do app os param.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::domain::{JobStatus, JobView, now_ms};
use crate::harness::EventEmitter;
use crate::workspace::exec::{self as process, ExecOutput, ExecRequest};

/// Jobs vivos (running/stopping) por conversa.
pub const MAX_CONCURRENT_JOBS_PER_CONVERSATION: usize = 8;
/// Retenção da saída por job (bytes); o excedente descarta o começo.
pub const RING_CAPACITY_BYTES: usize = 256 * 1024;
/// Tamanho do preview exibido no card/lista.
const PREVIEW_CHARS: usize = 400;

/// Erro estável de jobs (mesma convenção `CODE: mensagem` das tools).
#[derive(Debug, Clone)]
pub struct JobsError {
    pub code: &'static str,
    pub message: String,
}

impl JobsError {
    pub fn limit(limit: usize) -> Self {
        Self {
            code: "JOB_LIMIT",
            message: crate::i18n::t_args(
                "jobs.errors.limit",
                &[("limit", &limit.to_string())],
            ),
        }
    }

    pub fn not_found(job_id: &str) -> Self {
        Self {
            code: "JOB_NOT_FOUND",
            message: crate::i18n::t_args(
                "jobs.errors.notFound",
                &[("job_id", &job_id)],
            ),
        }
    }
}

impl std::fmt::Display for JobsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for JobsError {}

/// Estado interno de um job (protegido por mutex curto; IO nunca acontece aqui).
struct JobState {
    id: String,
    conversation_id: String,
    command: String,
    status: JobStatus,
    started_at: i64,
    started: Instant,
    duration_ms: u64,
    exit_code: Option<i32>,
    /// Saída retida (ring buffer): `retained_start` é o offset absoluto do byte 0.
    output: Vec<u8>,
    retained_start: usize,
    total_written: usize,
}

impl JobState {
    fn view(&self) -> JobView {
        let duration_ms = if self.status == JobStatus::Running {
            self.started.elapsed().as_millis() as u64
        } else {
            self.duration_ms
        };
        JobView {
            id: self.id.clone(),
            command: self.command.clone(),
            status: self.status,
            started_at: self.started_at,
            duration_ms,
            exit_code: self.exit_code,
            output_preview: preview(&self.output),
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.total_written = self.total_written.saturating_add(bytes.len());
        self.output.extend_from_slice(bytes);
        let overflow = self.output.len().saturating_sub(RING_CAPACITY_BYTES);
        if overflow > 0 {
            self.output.drain(..overflow);
            self.retained_start = self.retained_start.saturating_add(overflow);
        }
    }
}

struct JobInner {
    state: Mutex<JobState>,
    cancel: CancellationToken,
    /// Acorda leitores de `wait`/`job_output` (sempre que a saída muda ou o job fecha).
    notify: Notify,
}

impl JobInner {
    fn view(&self) -> JobView {
        self.state.lock().view()
    }

    fn is_running(&self) -> bool {
        self.state.lock().status == JobStatus::Running
    }

    fn finish(&self, result: Result<ExecOutput, process::ExecError>) {
        let mut state = self.state.lock();
        if state.status != JobStatus::Running {
            // kill() pode já ter marcado como Killed; preserva o status terminal.
            return;
        }
        match result {
            Ok(output) => {
                if !output.stdout.is_empty() {
                    state.append(output.stdout.as_bytes());
                }
                if !output.stderr.is_empty() {
                    state.append(b"\n[stderr]\n");
                    state.append(output.stderr.as_bytes());
                }
                if output.timed_out {
                    state.append(b"\n[timed out after the configured limit]\n");
                }
                if output.truncated {
                    state.append(
                        crate::i18n::t("jobs.truncatedHead").as_bytes(),
                    );
                }
                state.duration_ms = output.duration_ms;
                state.exit_code = output.exit_code;
                state.status = if output.cancelled {
                    JobStatus::Killed
                } else if output.exit_code == Some(0) {
                    JobStatus::Done
                } else {
                    JobStatus::Failed
                };
            }
            Err(error) => {
                state.append(format!("\n[{}: {}]\n", error.code, error.message).as_bytes());
                state.status = JobStatus::Failed;
                state.exit_code = error.exit_code;
            }
        }
        state.duration_ms = state.started.elapsed().as_millis() as u64;
        drop(state);
        self.notify.notify_waiters();
    }
}

fn preview(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    let preview: String = trimmed
        .chars()
        .rev()
        .take(PREVIEW_CHARS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Some(preview)
}

/// Registro process-wide dos jobs de processo (um por `AppState`).
#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Arc<JobInner>>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Inicia um job e devolve o snapshot `running` imediatamente.
    ///
    /// A execução roda sem timeout próprio (o job vive até terminar, ser morto
    /// ou o app encerrar); `command` é o texto exibido na UI (o `ExecRequest`
    /// só carrega argv).
    pub fn start(
        self: &Arc<Self>,
        conversation_id: &str,
        command: String,
        request: ExecRequest,
        emit: Arc<dyn EventEmitter>,
    ) -> Result<JobView, JobsError> {
        {
            let jobs = self.jobs.lock();
            let running = jobs
                .values()
                .filter(|job| {
                    let state = job.state.lock();
                    state.conversation_id == conversation_id
                        && state.status == JobStatus::Running
                })
                .count();
            if running >= MAX_CONCURRENT_JOBS_PER_CONVERSATION {
                return Err(JobsError::limit(MAX_CONCURRENT_JOBS_PER_CONVERSATION));
            }
        }

        let job_id = format!("job-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let cancel = CancellationToken::new();
        let inner = Arc::new(JobInner {
            state: Mutex::new(JobState {
                id: job_id.clone(),
                conversation_id: conversation_id.to_string(),
                command,
                status: JobStatus::Running,
                started_at: now_ms(),
                started: Instant::now(),
                duration_ms: 0,
                exit_code: None,
                output: Vec::new(),
                retained_start: 0,
                total_written: 0,
            }),
            cancel: cancel.clone(),
            notify: Notify::new(),
        });

        let initial = inner.view();
        self.jobs.lock().insert(job_id.clone(), inner.clone());
        emit.emit(crate::events::TurnEvent::JobUpdated {
            job: initial.clone(),
        });

        // A execução usa o token do job (não o do turno): trabalho longo
        // sobrevive ao cancelamento do turno, como no DSH.
        let mut request = request;
        request.cancel = cancel;
        request.timeout = Duration::ZERO;

        let registry = Arc::clone(self);
        let job = Arc::clone(&inner);
        tokio::spawn(async move {
            let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<(
                process::StreamKind,
                String,
            )>();
            let drain = {
                let job = Arc::clone(&job);
                tokio::spawn(async move {
                    while let Some((_stream, delta)) = receiver.recv().await {
                        job.state.lock().append(delta.as_bytes());
                        job.notify.notify_waiters();
                    }
                })
            };
            let result = process::run(request, Some(sender)).await;
            let _ = drain.await;
            job.finish(result);
            emit.emit(crate::events::TurnEvent::JobUpdated { job: job.view() });
            // Mantém o job listado após o término (histórico do painel); a
            // remoção é explícita (`remove`) ou no fechamento do app.
            let _ = &registry;
        });

        Ok(initial)
    }

    /// Jobs de uma conversa, do mais antigo para o mais novo.
    pub fn list(&self, conversation_id: &str) -> Vec<JobView> {
        let jobs = self.jobs.lock();
        let mut views: Vec<(i64, JobView)> = jobs
            .values()
            .filter_map(|job| {
                let state = job.state.lock();
                (state.conversation_id == conversation_id).then(|| (state.started_at, state.view()))
            })
            .collect();
        views.sort_by_key(|(started_at, _)| *started_at);
        views.into_iter().map(|(_, view)| view).collect()
    }

    /// Saída a partir de um cursor absoluto (bytes): `(output, next_cursor, job)`.
    pub fn output(
        &self,
        job_id: &str,
        cursor: usize,
    ) -> Result<(String, usize, JobView), JobsError> {
        let job = self.get(job_id)?;
        let state = job.state.lock();
        let retained_start = state.retained_start;
        let retained_end = retained_start + state.output.len();
        let start = cursor.max(retained_start).min(retained_end);
        let offset = start.saturating_sub(retained_start);
        let mut output = String::from_utf8_lossy(&state.output[offset..]).into_owned();
        if cursor < retained_start && !output.is_empty() {
            output.insert_str(
                0,
                &crate::i18n::t_args(
                    "jobs.ringBufferDropped",
                    &[("bytes", &retained_start.to_string())],
                ),
            );
        }
        Ok((output, retained_end, state.view()))
    }

    /// Snapshot de toda a saída retida (usado pelo foreground/promoção).
    pub fn snapshot_output(&self, job_id: &str) -> Result<String, JobsError> {
        let (output, _, _) = self.output(job_id, 0)?;
        Ok(output)
    }

    /// Espera até o job mudar de estado/saída, no máximo `timeout`.
    pub async fn wait(&self, job_id: &str, timeout: Duration) -> Result<JobView, JobsError> {
        let job = self.get(job_id)?;
        if !job.is_running() {
            return Ok(job.view());
        }
        let notified = job.notify.notified();
        tokio::pin!(notified);
        tokio::select! {
            _ = &mut notified => {}
            _ = tokio::time::sleep(timeout) => {}
        }
        Ok(job.view())
    }

    /// Pede o cancelamento do job. Retorna o snapshot atual (o estado terminal
    /// chega no próximo `JobUpdated`/`wait`).
    pub fn kill(&self, job_id: &str) -> Result<JobView, JobsError> {
        let job = self.get(job_id)?;
        job.cancel.cancel();
        job.notify.notify_waiters();
        Ok(job.view())
    }

    /// Remove o job do registro (não interrompe um job ainda em execução).
    pub fn remove(&self, job_id: &str) {
        self.jobs.lock().remove(job_id);
    }

    /// Cancela todos os jobs (encerramento do app/integração).
    pub fn cancel_all(&self) {
        let jobs = self.jobs.lock();
        for job in jobs.values() {
            job.cancel.cancel();
            job.notify.notify_waiters();
        }
    }

    pub fn len(&self) -> usize {
        self.jobs.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn get(&self, job_id: &str) -> Result<Arc<JobInner>, JobsError> {
        self.jobs
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| JobsError::not_found(job_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::EventEmitter;
    use crate::workspace::exec::{sanitized_env, shell_for};

    #[derive(Default)]
    struct Recorder {
        events: parking_lot::Mutex<Vec<serde_json::Value>>,
    }

    impl EventEmitter for Recorder {
        fn emit(&self, event: crate::events::TurnEvent) {
            if let Ok(value) = serde_json::to_value(&event) {
                self.events.lock().push(value);
            }
        }
    }

    impl Recorder {
        fn job_events(&self) -> Vec<serde_json::Value> {
            self.events
                .lock()
                .iter()
                .filter(|event| event.get("type").and_then(serde_json::Value::as_str) == Some("job_updated"))
                .cloned()
                .collect()
        }
    }

    fn registry() -> Arc<JobRegistry> {
        Arc::new(JobRegistry::new())
    }

    fn request(script: &str) -> ExecRequest {
        let (program, args) = shell_for(script);
        ExecRequest {
            program,
            args,
            cwd: std::env::temp_dir(),
            env: sanitized_env(&[("ZYLARA_AGENT", "1")]),
            timeout: Duration::ZERO,
            cancel: CancellationToken::new(),
            max_output_bytes: 1024 * 1024,
            stdin: None,
        }
    }

    fn shell_works(script: &str) -> bool {
        // Executa um comando trivial para saber se há shell utilizável no ambiente.
        let (program, args) = shell_for(script);
        std::process::Command::new(program)
            .args(args)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    async fn wait_until_settled(registry: &Arc<JobRegistry>, job_id: &str) -> JobView {
        for _ in 0..600 {
            let (_, _, view) = registry.output(job_id, usize::MAX).expect("job existe");
            if view.status != JobStatus::Running {
                return view;
            }
            let _ = registry.wait(job_id, Duration::from_millis(25)).await;
        }
        panic!("job {job_id} não terminou a tempo");
    }

    #[tokio::test]
    async fn starts_and_finishes_a_job_with_output() {
        if !shell_works("echo ok") {
            eprintln!("shell indisponível: teste pulado");
            return;
        }
        let registry = registry();
        let recorder = Arc::new(Recorder::default());
        let view = registry
            .start("conv-1", "echo ola".to_string(), request("echo ola"), recorder.clone())
            .expect("start");
        assert!(view.id.starts_with("job-"));
        assert_eq!(view.status, JobStatus::Running);
        assert_eq!(registry.list("conv-1").len(), 1);

        let settled = wait_until_settled(&registry, &view.id).await;
        assert_eq!(settled.status, JobStatus::Done);
        assert_eq!(settled.exit_code, Some(0));
        let output = registry.snapshot_output(&view.id).expect("saída");
        assert!(output.contains("ola"), "saída: {output}");
        assert_eq!(recorder.job_events().len(), 2, "running + final");
        assert_eq!(
            recorder.job_events()[1]["job"]["status"].as_str(),
            Some("done")
        );
    }

    #[tokio::test]
    async fn output_uses_absolute_cursor_and_pages() {
        if !shell_works("echo ok") {
            eprintln!("shell indisponível: teste pulado");
            return;
        }
        let registry = registry();
        let recorder = Arc::new(Recorder::default());
        let view = registry
            .start("conv-1", "echo abc".to_string(), request("echo abc"), recorder)
            .expect("start");
        wait_until_settled(&registry, &view.id).await;

        let (first, next_cursor, job) = registry.output(&view.id, 0).expect("page 1");
        assert!(first.contains("abc"), "saída: {first}");
        assert!(next_cursor > 0);
        assert_eq!(job.status, JobStatus::Done);
        let (rest, next_again, _) = registry.output(&view.id, next_cursor).expect("page 2");
        assert!(rest.is_empty(), "restante: {rest}");
        assert_eq!(next_again, next_cursor);
    }

    #[tokio::test]
    async fn kill_cancels_a_long_running_job() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 20";
        #[cfg(not(windows))]
        let script = "sleep 20";
        if !shell_works("echo ok") {
            eprintln!("shell indisponível: teste pulado");
            return;
        }
        let registry = registry();
        let recorder = Arc::new(Recorder::default());
        let view = registry
            .start("conv-1", script.to_string(), request(script), recorder)
            .expect("start");
        tokio::time::sleep(Duration::from_millis(150)).await;
        let killed = registry.kill(&view.id).expect("kill");
        assert_eq!(killed.status, JobStatus::Running, "cancel pedido, estado final assíncrono");
        let settled = wait_until_settled(&registry, &view.id).await;
        assert_eq!(settled.status, JobStatus::Killed);
    }

    #[tokio::test]
    async fn enforces_the_concurrent_job_limit_per_conversation() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 20";
        #[cfg(not(windows))]
        let script = "sleep 20";
        if !shell_works("echo ok") {
            eprintln!("shell indisponível: teste pulado");
            return;
        }
        let registry = registry();
        let recorder = Arc::new(Recorder::default());
        let mut started = Vec::new();
        for index in 0..MAX_CONCURRENT_JOBS_PER_CONVERSATION {
            let view = registry
                .start("conv-1", format!("{script} #{index}"), request(script), recorder.clone())
                .expect("start");
            started.push(view.id);
        }
        let error = registry
            .start("conv-1", script.to_string(), request(script), recorder.clone())
            .expect_err("deve estourar o limite");
        assert_eq!(error.code, "JOB_LIMIT");
        // Outra conversa tem orçamento próprio.
        let other = registry
            .start("conv-2", "echo x".to_string(), request("echo x"), recorder.clone())
            .expect("outra conversa");
        registry.cancel_all();
        let _ = wait_until_settled(&registry, &other.id).await;
        for id in &started {
            let _ = registry.wait(id, Duration::from_millis(500)).await;
            registry.remove(id);
        }
        registry.remove(&other.id);
    }

    #[test]
    fn unknown_jobs_return_not_found_and_remove_works() {
        let registry = registry();
        assert_eq!(registry.output("job-nope", 0).expect_err("sem job").code, "JOB_NOT_FOUND");
        assert_eq!(registry.kill("job-nope").expect_err("sem job").code, "JOB_NOT_FOUND");
        assert!(registry.is_empty());
    }
}
