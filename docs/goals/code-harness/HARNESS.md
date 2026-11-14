# HARNESS — Design do loop, permissões, contexto e persistência

> Parte do plano `docs/goals/code-harness/`. Aqui está o **como** do motor: loop de turno, perfil
> Chat × Code, pipeline de tools, política de permissões, workspace/FS seguro, execução de
> processos, git, contexto/compactação, persistência e segurança. Contratos de ferramenta:
> `TOOLS.md`. Fases e ownership: `PLAN.md`. UI: `WORKBENCH.md`.
>
> Base de pesquisa: `docs/research/dsh-harness-map.md` (DeepSeek Harness),
> `docs/research/paseo-workbench.md` (Paseo), `docs/research/agent-harness-patterns.md`
> (Codex/Claude Code/opencode/Aider/…), `docs/research/workspace-runtime-options.md`
> (viabilidade Rust/Windows) e `docs/research/lumina-harness-integration-map.md` (código atual).

## 1. Princípios

1. **Um loop, dois perfis.** O Lumina já tem um loop de agente maduro (passos, streaming,
   cancelamento, replay, usage). O harness de código **não** cria um segundo loop: ele
   parametriza o mesmo loop com um perfil de turno (prompt, tools, política, orçamentos) e
   mantém o caminho do Chat byte-compatível. Duplicar o loop seria a maior fonte de regressão.
2. **Ação sem consentimento é bug.** Toda tool mutante tem classe de risco e passa por uma
   política única. O modelo nunca decide sozinho se pode escrever fora do workspace ou rodar
   comando destrutivo.
3. **Tudo é auditável e reversível.** Cada mutação de arquivo deixa um registro com hash
   antes/depois (journal) e um evento na sessão; cada decisão de aprovação é auditada. O
   usuário consegue reverter turno/arquivo e revisar o diff.
4. **Contexto é orçamento.** O prompt não cresce sem controle: token meter, poda de tool
   results, compactação por resumo e spill. Sessão longa não morre por estouro de janela.
5. **Falha fechada.** Sem workspace, sem política, sem aprovador, sem shell: a tool recusa com
   erro acionável em vez de "tentar mesmo assim".
6. **O modelo é tratado como não confiável.** Saída de tool, arquivo lido, página web e
   instruções de repositório são **dados**. O prompt separa explicitamente instrução de app ×
   instrução de projeto × dado.

## 2. Componentes (Rust) e fronteiras

```
commands/
  turn.rs            run_turn (perfil: chat | code) · cancel_turn
  workspace.rs       abrir/listar/remover workspace · árvore · arquivo · busca · explorer
  git.rs             status/diff/stage/unstage/discard/commit/branch/log
  code.rs            estado da sessão de código · aprovações · jobs · revert · contexto
  terminal.rs        PTY: abrir/entrada/resize/fechar + Channel<TerminalEvent>   (v1.1)

harness/
  mod.rs             loop de turno (existente) + dispatch por TurnProfile
  profile.rs         TurnProfile { Chat, Code } → prompt/tools/policy/budgets
  prompt.rs          prompt do Chat (existente)
  code/prompt.rs     prompt do Code: seções + orientações geradas dos ToolSpec
  code/context.rs    projeto: AGENTS.md, manifests, árvore resumida, git resumo, token meter
  code/session.rs    code_events (log da sessão) + projeções (todos/plano/stats/changes)
  code/loop_hooks.rs checkpoints antes/depois de passo e de tool; repetição; stop

tools/
  registry.rs        ToolSpec, ToolCtx, pipeline, scheduling, timeouts, caps, spill
  fs_*.rs            read_file, read_image, list_dir, search_files, search_text, write_file,
                     edit_file, read_tool_output
  shell.rs           run_command (+ jobs)
  jobs.rs            job_list/job_output/job_kill
  git_read.rs        git_status/git_diff/git_log
  plan.rs            todo_write, submit_plan, ask_user
  (existentes)       web_search, fetch_url, skills, artifacts, genui

policy/
  mod.rs             PermissionMode, RiskClass, PolicyDecision, regras
  approval.rs        ApprovalBroker: pedido → evento → comando → decisão (oneshot)
  commands.rs        classificação de comandos (destrutivo/allowlist) e paths de segredo
  rules.rs           approval_rules (allow/deny por prefixo/glob, escopo sessão/workspace/global)

workspace/
  mod.rs             WorkspaceCtx (root canônico, git, config por workspace)
  safe_path.rs       resolução canônica, confinamento, symlink/`..`/UNC/device paths
  journal.rs         objetos por hash (checkpoints) + diff/added/removed + revert
  watch.rs           notify + debounce + filtro ignore → eventos de árvore/diff
  exec.rs            spawn/timeout/kill-tree/env-scrub/streaming (extraído de code_exec)
  git.rs             git CLI (argv seguro, env scrubbed, timeout, saída limitada)
  project.rs         detecção de projeto (Node/Rust/Python/Go/…): comandos de teste/lint/build
  objects.rs         store `<app-data>/checkpoints/objects/<hash>` (dedupe, GC)

state.rs             AppState + WorkspaceRegistry + JobRegistry + ApprovalBroker por turno
db.rs                migrações aditivas + consultas de workspaces/code_events/journal/summaries
```

**Regra de dependência**: `tools/*` e `policy/*` dependem de `workspace/*` e de `domain/*`;
`workspace/*` não conhece `harness/*` (só eventos via `emit`); `commands/*` é fino (validação +
chamada + erros `String`). Nada de `unwrap()` em caminho de dado do usuário.

## 3. Loop de turno (perfil Code)

### 3.1 Fases

```
run_turn(deps, payload{profile: code}, settings, emitter, cancel)
 1. Validação e contexto
    - carrega conversa; exige mode='code' OU code_linked (senão erro CONVERSATION_NOT_CODE)
    - resolve workspace da conversa; se ausente e o turno tem tool que exige workspace →
      erro WORKSPACE_REQUIRED antes de persistir (nada é escrito)
    - resolve modelo/protocolos/credencial (reuso integral do Chat)
    - carrega estado de sessão: permission_mode, plan_mode, todos, plano, sumários
    - monta ProjectContext (AGENTS.md, manifests, árvore, git) com cache do turno
    - monta prompt + tools + política
 2. Persistência inicial (mesma do Chat): user message + assistant placeholder + code_events
    - turn/started, step/started…
 3. Loop de passos (até max_steps do perfil):
    a) checkpoint antes do request (barreira de durabilidade do log da sessão)
    b) provider.stream_completion (reuso; fallback de protocolo e retry 401)
    c) acumula texto/reasoning/usage/tool calls (eventos incrementais já existentes)
    d) se há tool calls:
       - scheduler: agrupa Safe em paralelo (≤4), PathLocked por path, Exclusive em barreira
       - para cada tool: policy.decide → allow | ask(evento+await) | deny(resultado de erro)
       - executa com timeout real do contrato (abort do future → TOOL_TIMEOUT)
       - emite ToolProgress (streaming de saída), ToolCallFinished (+ presentation)
       - journal captura mudanças; emite FileChanged/WorkspaceChanges ao fim do passo/turno
       - resultados entram no histórico (24k chars; spill acima)
    e) compactação automática se pressão de contexto ≥ gatilho (§10)
    f) repete
 4. Resposta final forçada (sem tools) se o loop terminou sem texto final
 5. Finalização: persiste mensagem + provider_state v2 + usage; changes summary; emite Done
 6. Título automático (heurística; opcional modelo)
```

### 3.2 Checkpoints de durabilidade (lição do DSH, adaptada)

O log da sessão (`code_events`) precisa estar durável **antes** de efeitos externos:

| Momento | O que é gravado | Falha |
| --- | --- | --- |
| Início do passo | `step/started` | aborta o turno com erro claro |
| Antes de tool mutante | `tool/dispatched` (nome, args hash, path) | aborta a tool (`POLICY_UNAVAILABLE`) e não executa |
| Depois de tool mutante | `tool/settled` (resultado resumido) | marca `outcome_unknown` no evento e continua; o modelo recebe resultado sintético |
| Fim de turno | `turn/ended` (status, usage, changes) | marca sessão como "interrompida" na próxima abertura |

Crash no meio: ao abrir a conversa, um turno sem `turn/ended` vira mensagem `status='cancelled'`
+ evento `turn/interrupted` (a UI oferece "retomar" = novo turno com resumo do que ficou pendente).
**Não** há retry automático de efeito externo cujo resultado é desconhecido (princípio do DSH).

### 3.3 Cancelamento e parada

- `cancel_turn` (existente) aborta stream + current tool (o executor mata a árvore de processos).
- Tool em aprovação pendente → cancelar resolve a aprovação como `cancelled` e o resultado da tool
  vira `Error: cancelled by user` (o turno fecha como `Cancelled`, parcial preservado).
- **Semântica de stop**: parar o turno **não** mata jobs em background (eles são processos
  independentes e ficam no painel); a UI pergunta "parar e manter jobs?" na primeira vez.
- Sem fila de steering na v1 (mensagem durante o turno fica desabilitada/na fila do composer);
  v1.2 adiciona `steer` (lição do inbox do DSH) se houver demanda.

### 3.4 Concorrência entre sessões

- Cada conversa tem no máximo 1 turno ativo (`AppState` já registra por turn_id; adicionar
  verificação por conversation_id → erro `TURN_IN_PROGRESS`).
- Duas sessões do mesmo workspace podem rodar em paralelo: o journal e o watcher são por sessão,
  mas os paths podem conflitar → `PathLock` global por workspace (arquivo) + aviso na UI
  ("outra sessão está editando src/app.ts").
- Aprovações são por turno (broker), nunca globais.

### 3.5 Completion gate (parada verificada)

Uma resposta final sem tool calls só encerra o turno se o trabalho estiver comprovadamente
fechado. O gate (`harness/completion.rs`) roda apenas em turnos Code top-level (`turnKind=user`,
`delegationDepth=0`); Chat, subagentes e rodadas de objetivo mantêm a própria semântica de parada.

**Evidência acumulada por turno** (`TurnProgress::observe`):
- `file_change` → mutação + ecossistema do path (`.ts/.tsx/.js` = node, `.rs` = rust, `.py` =
  python, `.go` = go, `.cs/.csproj` = dotnet; manifestos por nome). Edições só de documentação
  (`*.md`, `*.txt`, …) contam como mutação mas não invalidam um check aprovado.
- `run_checks`/`run_command` de verificação → recibo com exit code, contagem de mutações no
  momento e **cobertura por ecossistema** (o `run_checks` publica `check`/`command`/`ecosystem`
  na presentation; `run_command` é classificado pelo comando — `cargo check`, `pnpm typecheck`,
  `pytest`, `go test`, `dotnet build`, …). Um check de uma linguagem não cobre outra.
- `todo_write`/`submit_plan` → marcador na contagem de mutações daquele momento.
- `task` com `worker` → mutação (o filho edita fora do journal) e exige verificação posterior.

**Decisão de parada**, nesta ordem: pergunta pulada sem trabalho novo → aceita; plano submetido
sem edições posteriores → aceita; modo Plano sem plano → continua; todo pendente/em andamento →
continua; último check do turno falhou → continua; algum ecossistema alterado sem check aprovado
depois da última edição → continua; worker sem check posterior → continua; mutações sem
`todo_write` → continua; resposta final declara trabalho parcial/não verificado → continua.
Perguntas de Code sem mutação não passam pela auditoria de texto (podem descrever código
existente).

A auditoria de texto cobre adjetivos de incompletude em inglês/pt-BR/es ("not verified",
"não implementado", "pendente", "parcial", "incomplete", …) e respeita negações ("nenhum item
pendente", "no pending work"). Ela existe para o caso em que o modelo marca todos os todos como
concluídos e ainda assim termina com um relatório parcial.

Cada rejeição injeta uma mensagem `[completion-gate]` (user, transitória) e mantém a resposta
rejeitada no histórico do turno, nunca na mensagem final nem no replay. O limite é
`MAX_STOP_CONTINUATIONS` (4); se o orçamento de passos acabar ou o limite for atingido, o turno
fecha como `incomplete` (badge na UI) e `turn/ended` grava `status`, `incompleteReason` e
`stopContinuations`.

**Ecossistemas verificáveis**: `workspace::project::detect` lê o manifesto raiz (contrato
`kind/name/checks` da UI) e soma manifestos aninhados até 2 níveis (sem
`node_modules`/`target`/dotfiles), produzindo `ProjectInfo.checkedEcosystems`. Num app Tauri com
`package.json` na raiz e `src-tauri/Cargo.toml`, editar `src/app.tsx` e `src-tauri/src/lib.rs`
exige um check Node **e** um check Rust depois das respectivas últimas edições. O prompt lista os
ecossistemas aninhados e o `run_checks` continua rodando apenas os checks do manifesto raiz;
checks aninhados vão por `run_command` com `workdir`.

**Limite explícito**: o harness não julga se uma feature está semanticamente completa. Ele
garante que (a) não há todo aberto, ledger ausente, check falhando ou ecossistema alterado sem
verificação posterior, e (b) a resposta final não admite trabalho pendente enquanto ainda há
trabalho executável. Bloqueios reais devem virar `ask_user` ou uma falha declarada com evidência.

## 4. Perfis de turno

```rust
#[serde(rename_all = "snake_case")]
pub enum TurnProfile { Chat, Code }

pub struct TurnProfileSpec {
    pub max_steps: u32,                  // Chat 64 · Code 120
    pub max_parallel_tools: usize,       // 4 · 4 (Safe)
    pub prompt: fn(&TurnInput) -> String,
    pub tools: Vec<ToolSpec>,
    pub policy: PolicyConfig,
    pub history: HistoryMode,            // Chat: orçamento por chars · Code: sumários+pruner
    pub auto_title: bool,
}
```

- `TurnPayload` ganha `profile: Option<TurnProfile>` (default `Chat`) — **retrocompatível**
  (`#[serde(default)]`); o backend valida contra `conversation.mode/code_linked`.
- O renderer envia `profile: 'code'` quando `layoutMode === 'code'` e a conversa é do Code
  (fonte: `src/lib/conversations.ts`), senão `chat`.
- Prompt/tools/política são resolvidos no backend; o renderer nunca decide o que o modelo pode.

## 5. Pipeline de tools

### 5.1 Contrato

`ToolSpec` está em `TOOLS.md` §3. O pipeline é fixo e igual para todas as tools:

```
1. validação de argumentos (JSON Schema)      → TOOL_INVALID_ARGS
2. política (policy.decide)                    → allow | ask | deny(reason)
3. se ask: ApprovalBroker.request(...)         → evento → comando → decisão (10 min; plano sem prazo)
4. timeout do contrato (real, não decorativo)  → TOOL_TIMEOUT (abort do future + kill do processo)
5. execução (com ToolCtx e CancellationToken filho)
6. caps/retention → spill se estourar          → content head/tail + spill id
7. apresentação (presentation) + summary
8. journal/auditoria + eventos
```

- **Timeout**: cada tool declara `timeout_ms` (default por classe: leitura 30 s; escrita 30 s;
  shell = parâmetro do modelo até 10 min; git 30 s). O runtime aplica `tokio::time::timeout`
  + abort; processo filho recebe kill de árvore. Testar o timeout é obrigatório (o DSH tinha
  timeout declarativo não aplicado — não repetir).
- **Erros** são resultados (`Error: …` + código), nunca propagam para derrubar o turno; só falhas
  de infraestrutura do turno (provider) encerram o turno.
- **Scheduling**: `Safe` (leitura/busca/git read/web) em paralelo até 8; `PathLocked` (write/edit)
  paralelo por arquivo distinto, serializado no mesmo path; `Exclusive` (run_command, todo_write,
  submit_plan, ask_user, job_kill) age como barreira — mantém a ordem do modelo. Ordem canônica
  dos resultados = ordem original das tool calls (provider exige pareamento).
- **Repeat guard**: mesma tool + mesmos args 3× → injeta lembrete no próximo passo (advisório,
  não bloqueia); 8× → aviso forte. Limpo por nova mensagem do usuário.

### 5.2 Caps e spill

| Onde | Cap | O que acontece acima |
| --- | --- | --- |
| resultado para o modelo | 24 000 chars | texto completo vai para `<app-data>/spill/<conversation>/<id>.txt`; modelo recebe head 12k + tail 4k + id + dica `read_tool_output` |
| resultado para a UI | 8 000 chars no card; streaming ao vivo | card mostra "ver saída completa" (leitura paginada do spill) |
| arquivo lido | 512 KB/chamada | paginação por offset |
| saída de processo | 1 MB backend | spill; tail no resultado |
| arquivos em `list_dir`/`search_*` | 400/200 | aviso + dica de refinar |
| diff git | 40 000 chars | aviso + "use paths/diff por arquivo" |

Spill: diretório privado por sessão, GC de 30 dias (config), nunca indexado pelo git, conteúdo
tratado como dado. `read_tool_output` só lê spills da própria sessão.

## 6. Política de permissões

### 6.1 Modos de sessão (chip no header / `/permissoes`)

| Modo | Leitura | Escrita no workspace | Shell | Git (UI) | Fora do workspace | Uso |
| --- | --- | --- | --- | --- | --- | --- |
| **Leitura** | ✅ | ❌ (erro de política) | somente leitura | só leitura | ❌ | explorar/entender código |
| **Editar** | ✅ | ✅ auto | **pergunta** (leitura livre) | stage/commit manual | pergunta | dia a dia |
| **Autônomo** | ✅ | ✅ auto | ✅ auto (inclusive destrutivo) | stage/commit manual | ✅ auto (fora do Plano) | tarefas longas confiadas |
| **Revisar** (saída do Plano) | ✅ | ✅ **com aprovação por escrita** | pergunta (leitura livre) | stage/commit manual | pergunta | revisar cada edição após aprovar um plano |
| **Plano** (overlay) | ✅ | ❌ | somente leitura | só leitura | ❌ | planejar antes de executar |

- Sessões novas do Code nascem no **modo padrão configurado pelo usuário**
  (`Settings.codeDefaultPermissionMode`, padrão **Autônomo**; Configurações → Ferramentas →
  Sessões de código); uma sessão do Chat compartilhada com o Code adota esse padrão ao entrar
  no layout. O chip do composer troca o modo por sessão a qualquer momento.
- Mudança de modo é **ação explícita do usuário** (chip ou `/permissoes`), registrada na sessão
  (`permission/mode` em `code_events`) e informada ao modelo **no mesmo turno**: a política relê
  `permission_mode`/`plan_mode` do banco a cada tool call e o loop anexa uma nota de
  "# Permission update" ao system prompt quando o estado muda entre passos.
- Modo Plano é overlay (vale sobre qualquer modo), ativado por `/plan` ou chip, e tem **quatro
  saídas** no gate do card: **Aprovar e executar** (Plano off, mantém o modo de permissão atual),
  **Aprovar e revisar cada edição** (Plano off → Revisar: cada escrita pede aprovação),
  **Continuar planejando** (Plano permanece, feedback persistido em `plan/feedback`) e
  **Executar como Objetivo** (`approve_goal`: aprova o plano, preserva o modo e cria um Goal com
  continuidade automática). O plano é editável antes de valer e o texto aprovado é o persistido.
- A aprovação destrava a execução **no mesmo turno** (não exige nova mensagem); o turno continua
  bloqueado até a decisão, com timeout individual de aprovação (default 10 min, configurável).
  A revisão do plano é a exceção: não expira e aguarda aprovar/negar/cancelar o turno. No modo
  **Autônomo** não há cards de aprovação (regras explícitas de negação e o overlay Plano
  continuam valendo).
- A UI **nunca** muda o modo de uma sessão em andamento automaticamente (o padrão configurado
  só é aplicado na criação da sessão e ao compartilhá-la com o Code). O modelo nunca muda o modo
  (pode sugerir).

### 6.2 Matriz de decisão (ordem de precedência)

```
1. Regra dura: plano ativo + tool mutante            → DENY (PLAN_MODE_ACTIVE)
2. Modo Autônomo                                     → ALLOW (exceto approval_rules DENY)
3. Regra dura: path fora do workspace                → ASK (risk=outside) / DENY em Leitura
4. Regra dura: arquivo de segredo                    → ASK (risk=secret) — leitura e escrita
5. Regra dura: comando destrutivo                    → ASK (risk=destroy) nos modos interativos
6. approval_rules (escopo sessão > workspace > global) → ALLOW/DENY explícito
7. Padrão do modo (§6.1)
8. Fallback para tool com risk >= write              → ASK
```

- O gate do modo Plano vale para mutações **de workspace** (arquivo/shell/git). `todo_write` e
  `submit_plan` são estado de sessão e não passam por esse gate; `todo_write` declara
  `mutating: false`/`risk: read` no registry.
- `run_command` classifica comandos de inspeção conhecidos como **não mutantes**
  (`is_readonly_command`, `workspace/exec.rs`): no modo Plano e no modo Leitura eles rodam sem
  aprovação, enquanto escrita/edição/instalação/composição continuam negadas. A allowlist é
  conservadora e recusa `;`, `&`, `|`, redirecionamento, caminhos como programa, `find
  -delete/-exec*`, `fd -x/-X`, `rg/ag --pre*`, `file -C` e opções de git que executam comandos ou
  escrevem (`-c/-C`, `--exec-path`, `--git-dir`, `--work-tree`, `--output`, `--ext-diff`,
  `--textconv`, `--open-files-in-pager`, `--pager`). `branch` e `remote` ficam fora da allowlist.
- No modo **Revisar**, toda tool `risk=write` (write/edit) e `shell` recebe `ASK`, mantendo o
  precedente de destrutivo/segredo/fora do workspace.

- `approval_rules` são criadas por "Sempre permitir…" no card de aprovação, com escopo explícito
  (esta sessão / este workspace / sempre) e matcher (`exact`, `prefix`, `glob`), e podem ser
  revogadas em Configurações → Aprovações. Deny sempre vence allow.
- **Auditoria**: `code_events` registra `approval/asked` e `approval/decided` (decisão, escopo,
  regra aplicada, timestamp). A UI de sessão lista as decisões.

### 6.3 Aprovação interativa (broker)

```rust
pub struct ApprovalRequest {
    pub id: String,              // aprov-<uuid>
    pub tool_call_id: String,
    pub tool: String,
    pub title: String,           // "Executar comando?"
    pub detail: ApprovalDetail,  // Command{ command, workdir } | Paths{ paths, change } |
                                 // Secret{ path } | Outside{ path } | Other{ text }
    pub risk: RiskClass,
    pub preview: Option<DiffPreview>, // diff do que será escrito (editar/plano)
    pub options: Vec<ApprovalOption>, // Aprovar / Negar / Sempre permitir(escopos)
    pub default: ApprovalDecision,    // Deny (Enter não aprova comando destrutivo)
}
```

- `submit_plan` usa **options próprias do plano** (`approve_run` / `approve_review` /
  `approve_goal` / `keep_planning`), sem "Sempre permitir"; `ApprovalOutcome`/`respond_approval` carregam
  `choice: Option<String>` e `plan_markdown: Option<String>`. O comando resolve o pedido antes de
  criar regra/auditoria: pedido morto (timeout/cancelamento) devolve `APPROVAL_NOT_FOUND` sem
  efeito colateral.

- Fluxo: tool → `broker.request()` → emite `TurnEvent::ApprovalRequested` → renderer mostra card →
  `invoke('respond_approval', { approvalId, decision, scope?, feedback?, choice?, planMarkdown? })`
  → broker resolve o `oneshot` → tool continua/aborta → emite `ApprovalResolved`. `choice`
  (`approve_run`/`approve_review`/`approve_goal`) e `planMarkdown` só valem para `submit_plan`; aprovações
  genéricas rejeitam esses campos.
- Timeout 10 min (config) → `deny` com `APPROVAL_TIMEOUT`; cancelamento do turno → `cancelled`.
  A revisão do plano usa o broker sem deadline e só resolve em aprovação/negação/cancelamento.
- Sem aprovador (teste/headless) → `APPROVAL_UNAVAILABLE` (fail-closed).
- Negar com feedback: o texto vira parte do resultado da tool ("usuário negou: <feedback>") para o
  modelo aprender e se adaptar.
- Aprovação é **one-shot** por request; "Sempre permitir" cria uma regra (explícita) — desvio
  consciente do DSH (lá não existe allow-always), porque no desktop o hábito pesa mais que o rigor
  e a regra é auditável/revogável.

### 6.4 Classificação de comandos (shell)

- **Destrutivo (sempre ASK)**: `rm -rf`, `rmdir /s`, `Remove-Item -Recurse -Force`, `del /f /s`,
  `format`, `git reset --hard`, `git clean -fdx`, `git checkout -- .`, `git restore .`,
  `git push --force*`, `git branch -D`, `npm publish`, `cargo publish`, `DROP TABLE|DROP DATABASE`,
  `shutdown`, `Stop-Computer`, `> /dev/sd*`, `mkfs`, `curl … | sh`, `iwr … | iex`, `npm i -g`.
- **Leitura conhecida (roda sem aprovação nos modos Editar/Revisar/Plano/Leitura)**: `git
  status|diff|log|show|grep`, `ls|dir`, `cat|type|Get-Content`, `rg|grep|findstr`, `wc`,
  `head|tail`, `find` sem `-delete`/`-exec*`, `fd` sem `-x`/`-X`, versões de toolchain. `branch`
  e `remote` ficam de fora (flags mutantes).
- A classificação é **conservadora**: o que não casar como leitura conhecida e não for destrutivo
  fica no default do modo (ASK em Editar, ALLOW em Autônomo; no Plano/Leitura, DENY). O parser não
  tenta interpretar shell completo (impossível): recusa composição (`;`, `&`, `|`, redirecionamento,
  `$(`), caminhos como programa, `rg/ag --pre*`, `file -C`, `find` com `-exec*`/`-delete`/`-fprint*`,
  `fd -x/-X` e opções de git que executam comandos ou escrevem (`-c/-C`, `--output`, `--ext-diff`,
  `--textconv`, `--open-files-in-pager`, `--pager`, ...).

## 7. Workspace e filesystem seguro

### 7.1 Workspace

- `Workspace = { id, name, path, created_at, last_opened_at, pinned }` — pasta do usuário, não
  gerenciada. Git é **opcional** (workspace sem repo funciona: journal/diff funcionam, painel Git
  mostra "não é um repositório").
- O `path` é canonicalizado na abertura (UNC, symlinks, drive relativo, caminho com `..`); falha →
  erro `WORKSPACE_UNREADABLE`.
- O root do workspace é imutável por sessão (trocar = nova sessão ou "mover sessão", v1.2).
- Operações de arquivo **sempre** relativas ao root no resultado; internamente absolutas.

### 7.2 `safe_path` (confinamento)

```rust
pub fn resolve(root: &Path, requested: &str, mode: Access) -> Result<PathBuf, FsError>
```

- Rejeita: caminho vazio, NUL, device paths (`\\?\`, `\\.\`), UNC para fora, `..` que escapa,
  symlink/junction que aponta para fora (canonicaliza o pai e verifica prefixo; para arquivo novo,
  canonicaliza o diretório existente mais próximo).
- `Access::Read` × `Access::Write`: escrita exige o path dentro do root; leitura fora do root só
  via aprovação (`ReadOutside`).
- Windows: normaliza para `\` internamente e devolve `/` no IPC; case-insensitive na comparação
  (`eq_ignore_ascii_case` no prefixo), mas preserva o case real do disco.
- Testes: `..`, symlink para fora, junction, caminho absoluto de outro drive, `\\?\C:\`, path
  longo (>260), unicode, drive relativo (`C:`), case.

### 7.3 Leitura/escrita

- **Encoding**: detectar BOM (UTF-8/UTF-16LE/BE), validar UTF-8; se falhar, tentar CP1252
  (Windows) e sinalizar no cabeçalho (`(encoding windows-1252)`); BOM preservado na escrita.
- **EOL**: detectar (LF/CRLF/CR); ao editar, preservar; ao criar, usar EOL predominante do
  workspace (ou LF quando não há).
- **Escrita atômica**: escrever em `<path>.lumina-tmp-<rand>` no mesmo diretório → fsync → rename
  (no Windows `ReplaceFileW`/`rename` com retry para locks de antivírus). Nunca truncar antes de
  obter o novo conteúdo.
- **Observação (read-before-write/CAS)**: por sessão, `HashMap<PathBuf, ObservedFile{ hash, mtime,
  len }>`; `read_file` registra; `write_file`/`edit_file` exigem observação **fresca** (hash atual
  == observado). Arquivo criado pela própria sessão conta como observado. `FS_NOT_OBSERVED` /
  `FS_STALE_VERSION` com instrução de re-leitura. Observações persistem no log para sobreviver a
  resume? — v1: por sessão em memória + reconstrução preguiçosa (após reabrir, primeiro write exige
  read; é a mensagem de erro que ensina o modelo).
- **Limites**: 2 MB por escrita; binário recusado (detecta NUL nos primeiros 8 KB).

### 7.4 Journal (checkpoints e alterações)

- Antes da **primeira** mutação de um path no turno, o journal grava o conteúdo anterior no object
  store (`<app-data>/checkpoints/objects/<sha256>`, dedupe). Ao fim do turno, grava o estado final
  e calcula `added/removed` (diff por linhas com timeout curto; degrada para "arquivo inteiro").
- `file_journal(conversation_id, turn_id, path, change_kind, before_hash, after_hash, added,
  removed, created_at)` — permite: card "N arquivos alterados", painel Alterações, **reverter turno**
  e **reverter arquivo**.
- **Reverter**: para cada path do turno (ordem inversa), comparar hash atual com `after_hash`; se
  mudou por fora → recusar com aviso ("o arquivo mudou desde o turno"); senão restaurar
  `before_hash` (ou apagar se criado). Reverter é ação do usuário com confirmação; fica registrada
  (`revert/performed`).
- Diferença entre **Alterações da sessão** (journal) e **Alterações do git** (working tree): a UI
  mostra as duas com origem marcada (`sessão` / `git` / `ambos`); o commit usa o working tree real.

### 7.5 Watcher

- `notify` (sem `notify-debouncer-full`: coalescedor próprio com quiet window de 400 ms e no
  máximo 1 evento/segundo), watch recursivo do workspace com exclusões (`.git` exceto
  `HEAD`/`index`/`refs`/`packed-refs`, `node_modules`, `target`, `dist`, `build`, `.venv`,
  `__pycache__`, `.next`, e padrões do `.gitignore` da raiz via `ignore`). Fallback `PollWatcher`
  (2 s) quando o backend nativo falha (share de rede, limite de inotify).
- Eventos → invalidação de cache da árvore + `zylara:workspace-changed` (coalescido, no máximo
  1/segundo) para a UI atualizar árvore/status sem reload. Se o repo for grande (> 20k arquivos),
  watch apenas os diretórios visíveis e recarregar sob demanda (decisão de performance na fase 2).
- Nunca confiar no watcher para correção: toda leitura de estado (status/diff) é refeita no backend
  quando a UI pede; o evento é só um "avise-se".

## 8. Execução de processos

### 8.1 `exec.rs` (extraído de `tools/code_exec.rs`)

```rust
pub struct ExecRequest {
    pub program: String,          // "pwsh" | "powershell" | "cmd" | "bash" | "sh"
    pub args: Vec<String>,        // argv explícito (nunca shell-in-string para git)
    pub script: Option<String>,   // só para run_command (string do modelo)
    pub cwd: PathBuf,
    pub timeout: Duration,
    pub env: BTreeMap<String, String>, // já higienizado
    pub on_output: Option<OutputSink>, // streaming incremental (ToolProgress / TerminalEvent)
    pub cancel: CancellationToken,
}
```

- **Shell**: Windows → `pwsh -NoLogo -NoProfile -NonInteractive -Command <script>`; fallback
  `powershell.exe` e, por último, `cmd.exe /C` (só quando o script não usa sintaxe PowerShell).
  Unix → `bash -lc <script>` (ou `sh`). `workdir` resolvido no workspace e validado.
- **Sem stdin** por padrão (stdin fechado) — terminal interativo é PTY (v1.1).
- **Encoding de saída**: ler bytes, tentar UTF-8; se inválido, decodificar CP850/CP1252 (Windows)
  e sinalizar; nunca perder bytes (substituição U+FFFD contabilizada).
- **Env**: remover `*API_KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `LUMINA_*`
  internos; adicionar `LUMINA_AGENT=1`, `LUMINA_WORKSPACE=<root>`, `TERM=dumb`, `NO_COLOR=1`,
  `GIT_TERMINAL_PROMPT=0`; manter `PATH`/`HOME`/`TEMP` do usuário.
- **Árvore de processos**: Job Object no Windows (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` +
  `AssignProcessToJobObject`) para matar filhos no cancelamento/timeout; Unix: process group
  (`setsid` + `kill(-pgid)`). Teste com processo que gera filho.
- **Streaming**: `on_output` coalesce chunks (≥ 16 ms ou ≥ 4 KB) antes de emitir — evita inundar
  o IPC (lição do DSH/jobs com ring buffer). UI recebe `ToolProgress { id, stream, delta }`.
- **Timeout**: `tokio::time::timeout` → kill tree → resultado `[timed out after Nms]`; em
  `run_command` foreground, **promove a background job** em vez de matar (configurável).

### 8.2 Jobs

- `JobRegistry` por sessão: id curto (`job-<8hex>`), comando, cwd, status, ring buffer de saída
  (256 KB), cursor por leitor, started/finished, exit.
- Limite 8 concorrentes + fila; job órfão após cancelar turno continua e a UI mantém o card.
- Notificação: ao terminar, o modelo recebe (no próximo passo do turno ativo ou no próximo turno)
  uma mensagem de sistema compacta: `[job job-1a2b terminou com exit 0 — use job_output para ler]`.
- Persistência: v1 em memória (some ao fechar o app, como DSH); v1.1 opcional tabela + retomada
  com aviso "processo anterior não sobreviveu ao fechamento".

### 8.3 Terminal (v1.1)

- `portable-pty` (ConPTY no Windows) → sessão `terminal-<id>` com shell do usuário (`pwsh`), cwd
  no workspace, tamanho (cols×rows), scrollback ring (1 MB).
- Comandos: `terminal_open`, `terminal_input`, `terminal_resize`, `terminal_close`, e
  `Channel<TerminalEvent>` por sessão (`{type:'data', bytes}` base64 ou string UTF-8 com
  substituição). Renderer: `@xterm/xterm` + `addon-fit` no painel direito (aba Terminal) e/ou
  centro (`codeView: 'terminal'`).
- Autorização: abrir terminal é ação do **usuário** (botão/atalho); o modelo usa `terminal_*`
  só se o usuário liberar (modo Autônomo ou regra) — v1.1 decide o default com base no uso.
- Testes: abrir/fechar, resize, output, kill de árvore, encoding, sessão morta.

## 9. Git

- **CLI do git** (`git` do usuário) via `exec` com argv explícito, env scrubbed
  (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=0`), timeout 30 s, saída
  limitada. Detectado na abertura do workspace (`git rev-parse --show-toplevel`); ausente → estado
  "git indisponível" honesto (não quebra o harness).
- **Leitura (modelo + UI)**: `status --porcelain=v2 -z`, `diff --no-color --no-ext-diff`,
  `log --oneline`, `rev-parse --abbrev-ref HEAD`, `for-each-ref` (branches).
- **Mutações (só UI, com confirmação)**: `add`/`restore --staged` (stage/unstage), `restore`
  (descartar — aprovação destrutiva), `commit -m` (mensagem do usuário ou sugerida por IA),
  `switch`/`checkout -b` (branch). Push/PR ficam para depois (v1.2/v1.3).
- **Não** usamos libgit2/gix na v1: menos dependência nativa, comportamento idêntico ao que o
  usuário vê no terminal, e o CLI cobre worktrees/config/hooks. Risco: git ausente/antigo →
  degradação explícita. (Confirmar com `workspace-runtime-options.md`; se o spike mostrar que
  `status`/`diff` via CLI é lento em repos grandes, otimizar com cache por mtime/índice.)
- **Commit**: staging selecionado ou **"tudo"** (nesse alvo o comando roda `git add -A` antes do
  `commit -m`, incluindo modificados, novos e deletados); mensagem obrigatória (não vazia), convenção
  detectada do repo (Commitlint/Conventional Commits se configurado); rodar hooks do git (usuário
  conhece).
  A mensagem sugerida pela IA é gerada por request curto não-streaming com o diff do alvo
  escolhido (tudo/preparados/seleção), sanitizada para uma linha de no máximo 72 caracteres, e
  **nunca** commitada automaticamente.

## 10. Contexto

### 10.1 Token meter

```rust
pub struct ContextBreakdown { pub system_prompt: u32, pub tool_definitions: u32, pub messages: u32 }
pub struct ContextStats { pub used: u32, pub window: u32, pub output_cap: u32, pub percent: f32,
                          pub compacted: u32, pub messages: u32, pub breakdown: ContextBreakdown }
```

- Estimativa `tokens ≈ chars / 4` + overhead por mensagem (8) / tool call (16); imagens ainda não
  entram no breakdown (limite documentado). O breakdown separa **prompt de sistema**, **definições
  de ferramentas** (nome + descrição + JSON Schema) e **mensagens** (texto, reasoning, argumentos e
  resultados de tools); a soma acompanha `used`.
- Uso real do provider (`usage.input_tokens`) **calibra o passo**: `used` passa a ser o valor real e
  o breakdown é escalado proporcionalmente (mensagens recebe o residual). A UI mostra "≈".
- **Tempo real**: emitir `TurnEvent::ContextStats` (e persistir em `code_events` `context/stats`) no
  início do turno, antes de cada passo, logo após cada passo com `usage.input_tokens` e no fecho;
  a cadência natural por passo satisfaz o limite de coalescência ≤ 1/s em produção. O último
  evento persistido é o que o snapshot devolve ao reabrir a sessão.
- **Custo em tempo real**: `TurnEvent::Usage` é emitido a cada request que reportou uso
  (`emit_live_usage`), com o **total acumulado** do turno — passos já mergeados em `total_usage`
  **mais** os subagentes concluídos (`subagent_usage`, merge só no clone, sem dupla contagem) — na
  mesma cadência do `cache_stats`. O evento de fecho continua sendo o valor autoritativo persistido
  em `assistant_message.usage` (com `durationMs`). O renderer precifica com o catálogo
  (`src/lib/sessionCost.ts`) e o `CodeContextMeterChip` relê o valor derivado no máximo a cada 10 s
  enquanto o turno roda (rede de segurança para evento perdido; ocioso não mantém timer).
- Compactação é registrada em `context/compacted` (`{messages, tokensFreed}`), separada do medidor;
  o contador `compacted` do `ContextStats` é o total de mensagens resumidas e é somado ao breakdown
  seguinte. A persistência do medidor é **best-effort**: falha de append em `context/stats` é
  logada e o evento ainda chega à UI; o snapshot mantém o último valor persistido com sucesso.

### 10.2 Poda de tool results ("pruner")

- Antes de cada request, resultados de tool antigos (fora da janela recente de 8 mensagens) acima de
  8 192 chars são substituídos por `head 4 096 + "\n…[meio podado: use read_tool_output <spill>]…\n"
  + tail 1 024`. O original está no spill; nada se perde para o usuário.
- Só roda quando há pressão (≥ 60% da janela) para não gastar tokens à toa.

### 10.3 Compactação

- **Gatilho**: `threshold = min(window × 0.75, window − output_cap − 8 192)`; ao atingir antes de um
  passo, compacta.
- **Seleção da região**: a mais antiga possível, sempre balanceada (nunca corta par
  tool_call ↔ tool_result), nunca inclui a última mensagem do usuário nem o último turno completo;
  retém ~20% da janela verbatim (recente).
- **Resumo**: request auxiliar **não-streaming** com template fixo de 8 seções (adaptado do DSH,
  prompt em inglês): *Main request · Decisions and architecture · Files and code · Errors and fixes ·
  Pending jobs/processes · Work in progress · Next step · Critical context*. Regras:
  preservar paths/comandos/erros literais, não inventar, não mencionar a compactação.
- **Persistência**: `session_summaries(conversation_id, from_seq, to_seq, content, tokens,
  created_at)` + evento `context/compacted`. O `build_history` do perfil Code insere o resumo no
  lugar das mensagens cobertas (as mensagens originais continuam no banco para a UI/transcript).
- **Falha** (provider erro): não compacta, emite aviso, tenta de novo no próximo passo; se a janela
  estourar, o `CONTEXT_WINDOW_EXCEEDED` do provider dispara 1 retry com compactação forçada.
- `/compact` manual no composer (v1.5).
- **UI**: "Contexto compactado — N mensagens resumidas · ~X tokens liberados" como card de sistema;
  o transcript real permanece visível (só o modelo vê o resumo).

### 10.4 Prompt (orçamento e cache)

| Seção | Orçamento alvo |
| --- | --- |
| identidade + regras de comunicação | 0,8k |
| ambiente (OS/shell/workspace/git/data) | 0,6k |
| política (modo, plano, segredos, untrusted) | 0,8k |
| estilo de trabalho (esforço proporcional, paralelismo, delegação) | 0,5k |
| orientações das tools (geradas por `ToolSpec`) | 3–4k |
| regras de edição/verificação | 1,2k |
| projeto (AGENTS.md + manifests + comandos + árvore resumida + git resumo) | 3–5k |
| formato de resposta/citações | 0,6k |
| UI generativa (notas do Code + seção gerada do contrato) | 2–3k |
| **total** | **~12–17k tokens** |

- Prefixo estável primeiro (identidade/ambiente/política/tools) em um **snapshot persistido por
  sessão** (`prompt_snapshots`); nada que muda em um turno normal entra no system prompt. O volátil
  (árvore/estado/plano/modo) vira `surface_item` na **última mensagem** do request, nunca no fim do
  system prompt: o system prompt precede o histórico nos 4 protocolos e qualquer mudança nele
  invalida todas as mensagens. Detalhes: `docs/goals/prompt-cache/PLAN.md` §4.2–§4.4.
- A seção de **UI generativa** é gerada de `data/genui-contract.json` (catálogo/regras/limites/
  exemplos) e entra no snapshot congelado; o Code adiciona só as notas de uso. Mudou o texto?
  Bump de `harness::code::prompt::PROMPT_VERSION`.
- Árvore resumida: até 120 entradas / 2 níveis; se maior, agrupar (`src/ (412 arquivos, 18 dirs)`).
- `AGENTS.md`: procurar do workspace root até o diretório de trabalho (se aninhado), concatenar com
  marcador de origem, cap 8 KB total; suportar também `.lumina/instructions.md` (opcional).
- **Project profile**: detectar Node (`package.json` scripts), Rust (`Cargo.toml`), Python
  (`pyproject.toml`), Go (`go.mod`), .NET (`*.csproj`); extrair comandos de test/lint/build e
  mostrar no prompt e na UI (menu "Verificações"): `npm test`, `cargo test`, `pytest`, etc.
- Nunca incluir segredos: filtrar `.env` do contexto automático (só via `read_file`, com
  aprovação fora do modo Autônomo).

## 11. Sessão e persistência

### 11.1 Modelo (migrações aditivas)

```sql
-- Workspace (pasta do usuário; git opcional)
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0
);

-- Conversa vira sessão de agente (colunas aditivas; bancos antigos ganham defaults)
ALTER TABLE conversations ADD COLUMN workspace_id TEXT;                        -- NULL = sem workspace
ALTER TABLE conversations ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'lumina'; -- futuro: 'acp:codex'
ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'edit';

-- Log da sessão: fatos de UI/auditoria (não substitui messages, que segue fonte do histórico do modelo)
CREATE TABLE IF NOT EXISTS code_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_id TEXT,
  seq INTEGER NOT NULL,          -- monotônico por conversa (alocado no backend)
  kind TEXT NOT NULL,            -- turn/step/tool/approval/plan/todo/changes/context/revert/job
  payload TEXT NOT NULL,         -- JSON (versionado por kind)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_events_conv_seq ON code_events(conversation_id, seq);

-- Journal de arquivos por turno (checkpoints/alteracões)
CREATE TABLE IF NOT EXISTS file_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  path TEXT NOT NULL,            -- relativo ao workspace
  change_kind TEXT NOT NULL,     -- created|modified|deleted
  before_hash TEXT, after_hash TEXT,
  added INTEGER, removed INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_journal_turn ON file_journal(conversation_id, turn_id);

-- Resumos de compactação (janelas de mensagens cobertas)
CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL, to_seq INTEGER NOT NULL,
  content TEXT NOT NULL, tokens INTEGER,
  created_at INTEGER NOT NULL
);

-- Regras "sempre permitir/negar"
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,           -- session|workspace|global
  scope_id TEXT,                 -- conversation_id | workspace_id | NULL
  tool TEXT NOT NULL,
  matcher TEXT NOT NULL,         -- exact|prefix|glob
  pattern TEXT NOT NULL,
  decision TEXT NOT NULL,        -- allow|deny
  created_at INTEGER NOT NULL
);
```

- Objetos de arquivo (checkpoints) ficam em `<app-data>/checkpoints/objects/<sha256>` (dedupe,
  GC por idade/uso); spills em `<app-data>/spill/<conversation>/`.
- `messages` continua sendo a fonte do histórico do modelo; `code_events` é a fonte da **superfície
  da sessão** (UI/auditoria/projeções). Justificativa: adotar event-sourcing completo de mensagens
  (como o DSH) exigiria substituir o `provider_state` v2 e o replay atuais — risco alto, ganho
  pequeno. O log de eventos captura 80% do valor (auditoria, projeções, crash recovery, revert) com
  migração aditiva.

### 11.2 Projeções

- `SessionProjection` = fold de `code_events` por conversa, em memória (`Arc<RwLock<…>>` por sessão
  ativa) e reconstruída ao abrir:
  `todos`, `plan`, `permission_mode`, `context_stats`, `changes(turn)`, `approvals(pending/histórico)`,
  `jobs(ativos)`, `checks(últimas execuções)`.
- UI recebe snapshot completo ao abrir (`get_code_session_state`) e deltas por eventos durante o
  turno (sem replay de transcript). Nenhuma tela recalcula: renderiza o que a projeção diz.
- `seq` monotônico por conversa garante ordem e re-sync (se o renderer perder evento, `get` refaz).

### 11.3 Título e metadados

- Título: heurística existente (primeira linha útil) + sufixo do workspace na sidebar; opcional
  modelo curto em v1.1 (config `auto_title`).
- `usage_log` já cobre tokens/custo por turno; code sessions exibem custo no header/popover.

## 12. Eventos e IPC

### 12.1 `TurnEvent` (aditivo, retrocompatível)

```rust
// novos (o renderer atual ignora desconhecidos; adicionar no fim do enum)
ApprovalRequested { approval: ApprovalRequest },
ApprovalResolved { approval_id: String, decision: String, scope: Option<String> },
ToolProgress { id: String, stream: Option<String>, delta: String },
FileChanged { change: FileChange },
WorkspaceChanges { summary: ChangesSummary },
TodosUpdated { todos: Vec<TodoItem> },
PlanUpdated { plan: PlanView },
ContextStats { stats: ContextStats },
Compacted { messages: u32, tokens_freed: u32 },
JobUpdated { job: JobView },
ProfileChanged { profile: String, permission_mode: String, plan_mode: bool },
ErrorCode { code: String }   // já existe Error{code}
```

- Regras: variante nova só no fim; campos opcionais com `#[serde(default, skip_serializing_if)]`;
  payloads pequenos (≤ 8 KB); nada de binário no evento (terminal usa base64/CHANNEL próprio).
- `ToolCallRecord` ganha `presentation: Option<Value>` (persistido no DB junto da mensagem) para
  auditoria/replay e consumidores futuros. O transcript **não** monta mais cards de tool (decisão de
  UX: o bloco "Thinking" resume a atividade; plano/tarefas/jobs vivem no popover do composer —
  `WORKBENCH.md` §5.2).
- `PlanUpdated { plan: PlanView }` é emitido em **entrar/sair do Plano, submissão
  (`state=reviewing`), feedback (`state=planning` + `plan.feedback`) e aprovação
  (`state=approved`)**. `PlanView` carrega `state`, `markdown?`, `feedback?` e `updated_at`
  (timestamp do evento de origem, nunca `now()`).
- `TodosUpdated` substitui a lista inteira; `todos: []` limpa (lista vazia é válida).
- `ProfileChanged` carrega o **estado real** (`plan_mode`/`permission_mode`) no início do turno e
  de novo quando o estado muda entre passos.
- `respond_approval` (IPC) aceita `choice` (`approve_run`/`approve_review`/`approve_goal`) e `plan_markdown`
  (plano revisado antes de valer) para decisões de `submit_plan`; escopos "sempre permitir" não se
  aplicam ao plano.

### 12.2 Comandos novos (IPC)

```
workspace:  pick_workspace_folder, add_workspace, list_workspaces, get_workspace,
            rename_workspace, remove_workspace, set_conversation_workspace,
            list_workspace_files, search_workspace_files, read_workspace_file,
            get_workspace_context (git branch/status/project profile), open_workspace_in_explorer
code:       get_code_session_state, set_permission_mode, set_plan_mode, respond_approval,
            list_approval_rules, save_approval_rule, delete_approval_rule,
            get_workspace_changes, get_file_diff, revert_file, revert_turn, compact_session,
            list_project_checks, run_project_check (v1.5)
git:        git_status, git_diff, git_stage, git_unstage, git_discard, git_commit,
            git_branches, git_switch_branch, git_log, suggest_commit_message
jobs:       list_jobs, get_job_output, kill_job
terminal:   open_terminal, write_terminal, resize_terminal, kill_terminal, close_terminal  (Channel<TerminalEvent>)
```

Todos `Result<T, String>`, camelCase, registrados em `lib.rs`, com testes de contrato (serialize
com golden JSON quando o DTO é novo).

## 13. Segurança (modelo de ameaça e o que prometemos)

| Ameaça | Mitigação no Lumina | Limite honesto |
| --- | --- | --- |
| Prompt injection em arquivo/web/issue | saída de tool como dado; prompt separa instrução × dado; aprovação para ações sensíveis; segredos fora do contexto automático | modelo ainda pode ser enganado; a política reduz o dano, não elimina |
| Comando destrutivo | classificação + ASK fora do Autônomo; kill tree; auditoria; sem auto-commit | usuário pode aprovar; no Autônomo roda direto; não há sandbox de SO na v1 |
| Escrita fora do workspace | `safe_path` + política `outside` (ASK) | symlink/junction cobertos por canonicalização; TOCTOU residual documentado |
| Vazamento de segredos para o modelo | scrub de env; padrões de arquivo de segredo com ASK fora do Autônomo; nunca injetar chaves do app no shell | arquivo de segredo lido com aprovação (ou direto no Autônomo) vai para o modelo |
| Perda de trabalho | journal/checkpoints + revert + diff antes de aplicar + sem `git reset` automático | revert recusa se o arquivo mudou por fora |
| Execução de código arbitrário | é o produto (shell) — confinamento é workspace + aprovação + auditoria; `run_command` é opt-in por sessão | não é sandbox de SO; documentar em Configurações |
| IPC malicioso | apenas o webview fala com o backend; CSP (hoje `null` — **dívida a corrigir** na Fase 0/8); sem `eval` | conteúdo de arquivo sempre renderizado como texto sanitizado |
| Abuso de aprovação | regras por escopo, auditadas e revogáveis; "sempre permitir" explícito | regra global pode ser ampla — UI deixa claro o escopo |

## 14. Verificação do harness

1. `cargo check` + `cargo test --lib` (tools, política, journal, git com repo temporário, exec com
   pwsh condicional, compactação, projeções, loop com provider falso e aprovação).
2. `pnpm typecheck` + `pnpm test` (cards, diff, aprovação, árvore, store, composer) + `pnpm build`.
3. Testes `#[ignore]` de integração com gateway real para o perfil Code (tool call + replay +
   cancelamento + compactação).
4. Checklist manual de release (abrir pasta real, tarefa real, diff, revert, commit) — sem
   automação de UI (regra do repo).
5. Cenários de caos: crash no meio do turno, cancelar durante aprovação, matar processo, repo com
   lock de arquivo (antivírus), workspace em drive de rede, arquivo com CRLF/BOM, path > 260.

## 15. Objetivo (Goal) — v1.11

Contrato completo: `docs/goals/code-goals/PLAN.md` (esse documento é a fonte de produto; esta seção
resume o acoplamento com o harness).

### 15.1 Persistência e projeção

- Um objetivo por sessão, projetado de `code_events` (append-only, sem tabela nova):
  `goal/state` (snapshot completo do `GoalView`, o último vence; revisão monotônica),
  `goal/deleted` (tombstone), `goal/round-started` e `goal/round` (histórico de rodadas).
- Projeção única: `harness/code/goal.rs::current/rounds`. `rounds()` recebe `active_turn` para
  distinguir rodada "em andamento" de "interrompida"; o `commands::code` degrada em **leitura**
  (`paused/interrupted`) quando a última rodada ficou órfã e não há turno ativo — sem gravar.
- Mutações com `GOAL_WRITE_LOCK` + CAS por `expectedRevision`; `begin_round` reconcilia órfã
  (`interrupted`) e é idempotente por `turnId`; `finish_round` também é idempotente.
- Limites: objetivo 4 000 chars, título 120, nota 2 000, motivo 500, rodadas 25 default / 100 cap,
  estol 3, bloqueio 3, lista de rodadas 200.

### 15.2 Rodada no loop

- `TurnPayload.turnKind = goal_round` (só perfil `code`, sessão do Code, top-level). Antes de
  persistir mensagens: recusas estáveis (`GOAL_TURN_REQUIRES_CODE`, `GOAL_REQUIRES_TOP_LEVEL`,
  `GOAL_INVALID_ARGS`) e `validate_round_start` (ativo, `rounds<max`, Plano inativo, sem
  aprovação/pergunta pendente, workspace no disco).
- `begin_round` antes de `prepare_new_turn`; a mensagem do usuário grava `origin = goal_round` e
  `payload.content = goal::round_prompt` (inglês, com o objetivo embutido).
- `GoalUpdated` é emitido após `turn_started` e no fecho (após `turn/ended`); `finish_round` recebe
  outcome (`done|cancelled|error`), usage do turno e `files_changed` do journal; pausa em
  erro/cancel/limite/estol e **nunca** sobrescreve conclusão/bloqueio/pausa do usuário.
- Auto-title não roda em `goal_round`; `create_goal` renomeia título placeholder para o do objetivo.
- **Ativação v1.12**: `/goal` ativa um chip no composer (a mensagem do usuário não é alterada) e
  o turno humano leva `goalRequest=true`; o harness injeta `## Goal request` no runtime context
  (volátil) instruindo a tool `goal` action `create` com os parâmetros do pedido. `create` honra
  `auto_continue` explícito (default do fluxo: true) e grava `origin=agent`. Com continuidade
  armada, o driver inicia a rodada ao fim do turno.

### 15.3 Prompt e cache

- `## Objective` é **volátil** (runtime context/surface item): status, armed, rodada, revisão,
  objetivo, tarefas, última nota, bloqueio e as 4 regras de autonomia. Turno humano usa o texto
  "Session objective (context; follow the user's message)"; rodada usa o texto de continuação.
- O system prompt/tools **não** carregam estado do objetivo (teste byte-a-byte entre passos e entre
  rodadas); a tool `goal` entra no catálogo Code (25 tools) e o subagente não a recebe.

### 15.4 Driver e eventos

- O driver é do renderer (`chatStore.maybeContinueGoal`), chamado no `done`: no máximo uma rodada,
  só com objetivo ativo + `autoContinue`, `rounds<max`, sem plano/aprovação/pergunta, sem streaming,
  sessão ativa no layout Code; `goal_can_continue` é o preflight final e o harness revalida.
- `stop()` em rodada pausa o objetivo; erro/cancel pausam no backend; reinício do app não retoma
  sozinho (`interrupted` até o usuário retomar).
- Comandos IPC: `create_goal`, `update_goal` (CAS/idempotente), `list_goal_rounds`,
  `goal_can_continue`; evento `goal_updated`; projeção em `CodeSessionState.goal`.
