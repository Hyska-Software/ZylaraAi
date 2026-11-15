//! Skill management commands (list / enable / disable / delete).
//!
//! Skills live on disk: bundled ones are materialized into
//! `<app-data>/skills-bundled/`, user ones are read from `<app-data>/skills/` and
//! skills installed by other agents (Agent Skills, Codex, Claude, OpenCode) are
//! read **read-only** from their standard repositories. Activation is persisted
//! by name in `Settings.disabled_skills`; deletion is only allowed for user
//! skills and only removes a direct child of `<app-data>/skills/`.
//! See docs/FILES.md §7.2 and §7.4.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use tauri::AppHandle;

use crate::config;
use crate::domain::{Settings, SkillContent, SkillSummary};
#[cfg(test)]
use crate::tools::skills::ExternalSkillRoot;
use crate::tools::skills::{self, Skill, SkillDraft, SkillSource, SkillVersion};

fn to_error(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

/// Diretório raiz das skills do usuário (`<app-data>/skills`).
fn user_skills_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("skills")
}

/* ------------------------------------------------------------------ */
/* Helpers puros (testáveis sem Tauri)                                 */
/* ------------------------------------------------------------------ */

/// Catálogo completo com os roots externos injetados, com os flags que a
/// interface usa: `enabled` vem de `settings.disabled_skills` e `deletable` só é
/// verdadeiro para skills do usuário (externas e embutidas são somente leitura).
///
/// Existe para os testes (roots determinísticos, sem tocar no home real); a
/// produção usa `collect`, que delega para as funções sem sufixo de `skills`.
#[cfg(test)]
fn collect_with_roots(
    data_dir: &Path,
    settings: &Settings,
    roots: &[ExternalSkillRoot],
) -> anyhow::Result<Vec<SkillSummary>> {
    let skills = skills::catalog_with_roots(data_dir, roots)?;
    Ok(skills
        .iter()
        .map(|skill| skill.summary(&settings.disabled_skills))
        .collect())
}

/// Produção: lê também os repositórios padrão de outros agentes (Codex, Claude,
/// OpenCode, Agent Skills) em modo somente leitura. As funções sem sufixo de
/// `tools::skills` já usam `standard_external_roots()`.
fn collect(data_dir: &Path, settings: &Settings) -> anyhow::Result<Vec<SkillSummary>> {
    let skills = skills::catalog(data_dir)?;
    Ok(skills
        .iter()
        .map(|skill| skill.summary(&settings.disabled_skills))
        .collect())
}

/// Liga/desliga uma skill por nome. Mantém `disabled_skills` normalizado (trim,
/// sem duplicatas, ordenado) e devolve `true` quando a lista realmente mudou.
fn toggle(settings: &mut Settings, name: &str, enabled: bool) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let before = settings.disabled_skills.clone();
    // Compara já com trim para não duplicar entradas legadas mal formatadas.
    settings.disabled_skills.retain(|entry| entry.trim() != name);
    if !enabled {
        settings.disabled_skills.push(name.to_string());
    }
    settings.disabled_skills = config::normalize_disabled_skills(std::mem::take(
        &mut settings.disabled_skills,
    ));
    settings.disabled_skills != before
}

/// Remove o diretório de uma skill **do usuário**.
///
/// Defesa contra caminhos maliciosos: o diretório precisa ser um filho direto de
/// `<data>/skills` (após resolver symlinks/junctions) e não pode ele mesmo ser
/// um link simbólico. Skills embutidas e de repositórios externos são recusadas
/// (somente leitura: a interface só permite desativá-las).
fn remove_user_skill(data_dir: &Path, skill: &Skill) -> anyhow::Result<()> {
    match skill.source {
        SkillSource::User => {}
        SkillSource::Bundled => bail!(crate::i18n::t_args(
            "skills.errors.bundledReadonly",
            &[("skill", &skill.name)],
        )),
        external => bail!(crate::i18n::t_args(
            "skills.errors.externalReadonly",
            &[("skill", &skill.name), ("source", external.as_str())],
        )),
    }

    let root = user_skills_dir(data_dir);
    let root = root.canonicalize().with_context(|| {
        crate::i18n::t_args(
            "skills.errors.userDirMissing",
            &[("path", &root.display().to_string())],
        )
    })?;

    let metadata = std::fs::symlink_metadata(&skill.dir).with_context(|| {
        crate::i18n::t_args(
            "skills.errors.notFoundAt",
            &[("skill", &skill.name), ("path", &skill.dir.display().to_string())],
        )
    })?;
    if metadata.file_type().is_symlink() {
        bail!(crate::i18n::t_args(
            "skills.errors.symlink",
            &[("skill", &skill.name)],
        ));
    }
    if !metadata.is_dir() {
        bail!(crate::i18n::t_args(
            "skills.errors.notDirectory",
            &[("skill", &skill.name)],
        ));
    }

    let dir = skill.dir.canonicalize().with_context(|| {
        crate::i18n::t_args(
            "skills.errors.resolvePath",
            &[("skill", &skill.name)],
        )
    })?;
    if dir.parent() != Some(root.as_path()) {
        bail!(crate::i18n::t_args(
            "skills.errors.notDirectChild",
            &[("skill", &skill.name), ("path", &root.display().to_string())],
        ));
    }

    std::fs::remove_dir_all(&dir)
        .with_context(|| {
            crate::i18n::t_args("skills.errors.deleteFailed", &[("skill", &skill.name)])
        })?;
    Ok(())
}

/// Carrega o catálogo (com roots injetados) e devolve a skill pedida pelo nome
/// canônico do frontmatter. Usado pelos testes; produção usa `find_skill`.
#[cfg(test)]
fn find_skill_with_roots(
    data_dir: &Path,
    name: &str,
    roots: &[ExternalSkillRoot],
) -> anyhow::Result<Skill> {
    let name = name.trim();
    if name.is_empty() {
        bail!(crate::i18n::t("skills.errors.nameRequired"));
    }
    let catalog = skills::catalog_with_roots(data_dir, roots)?;
    catalog
        .into_iter()
        .find(|skill| skill.name == name)
        .with_context(|| {
            crate::i18n::t_args("skills.errors.notFound", &[("skill", name)])
        })
}

/// Produção: resolve o nome no catálogo completo (incluindo externas). A função
/// sem sufixo de `tools::skills` já usa `standard_external_roots()`.
fn find_skill(data_dir: &Path, name: &str) -> anyhow::Result<Skill> {
    let name = name.trim();
    if name.is_empty() {
        bail!(crate::i18n::t("skills.errors.nameRequired"));
    }
    skills::read(data_dir, name)?.with_context(|| {
        crate::i18n::t_args("skills.errors.notFound", &[("skill", name)])
    })
}

/// Monta o [`SkillContent`] da pré-visualização a partir de uma skill já lida.
///
/// `content` é **somente o corpo** do `SKILL.md`: o frontmatter (nome/descrição)
/// não entra no Markdown exibido, porque esses dados vão nos metadados. `dir` é
/// o diretório absoluto da skill, apenas para exibição. Origens e precedência
/// (Zylara, repositórios externos e embutidas) em docs/FILES.md §7.2; gestão e
/// prévia da interface em §7.4.
fn content_of(skill: &Skill) -> SkillContent {
    SkillContent {
        name: skill.name.clone(),
        description: skill.description.clone(),
        source: skill.source_label(),
        dir: skill.dir.display().to_string(),
        content: skill.body.clone(),
    }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/// Lista todas as skills instaladas (inclusive desativadas) para a interface.
#[tauri::command]
pub fn get_skills(app: AppHandle) -> Result<Vec<SkillSummary>, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    let settings = config::load_settings(&app);
    collect(&data_dir, &settings).map_err(to_error)
}

/// Lê o conteúdo de uma skill para a pré-visualização em Markdown da interface.
///
/// Resolve o nome no mesmo catálogo da listagem (`find_skill`, incluindo as
/// skills de repositórios externos em modo somente leitura e as embutidas) e
/// devolve o corpo do `SKILL.md` **sem o frontmatter** — nome e descrição vão
/// nos metadados, e a `SkillsView` renderiza só as instruções. Nome vazio ou
/// desconhecido vira erro amigável. Somente leitura: nada é gravado em disco.
/// Ver docs/FILES.md §7.2 e §7.4.
#[tauri::command]
pub fn get_skill_content(app: AppHandle, name: String) -> Result<SkillContent, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    let skill = find_skill(&data_dir, &name).map_err(to_error)?;
    Ok(content_of(&skill))
}

#[tauri::command]
pub fn save_skill(app: AppHandle, draft: SkillDraft) -> Result<SkillContent, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    let skill = skills::save_user_skill(&data_dir, &draft, crate::domain::now_ms())
        .map_err(to_error)?;
    Ok(content_of(&skill))
}

#[tauri::command]
pub fn list_skill_versions(app: AppHandle, name: String) -> Result<Vec<SkillVersion>, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    skills::list_skill_versions(&data_dir, &name).map_err(to_error)
}

/// Ativa/desativa uma skill e devolve a lista atualizada.
#[tauri::command]
pub fn set_skill_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> Result<Vec<SkillSummary>, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    let mut settings = config::load_settings(&app);
    // Valida contra o catálogo: não gravamos nomes desconhecidos no settings.
    let skill = find_skill(&data_dir, &name).map_err(to_error)?;
    if toggle(&mut settings, &skill.name, enabled) {
        config::save_settings(&app, &settings).map_err(to_error)?;
    }
    collect(&data_dir, &settings).map_err(to_error)
}

/// Exclui uma skill do usuário e devolve a lista atualizada.
#[tauri::command]
pub fn delete_skill(app: AppHandle, name: String) -> Result<Vec<SkillSummary>, String> {
    let data_dir = config::data_dir(&app).map_err(to_error)?;
    let mut settings = config::load_settings(&app);
    let skill = find_skill(&data_dir, &name).map_err(to_error)?;
    remove_user_skill(&data_dir, &skill).map_err(to_error)?;
    // O nome pode estar em `disabled_skills`; não deve sobrar referência órfã.
    settings.disabled_skills.retain(|entry| entry != &skill.name);
    config::save_settings(&app, &settings).map_err(to_error)?;
    collect(&data_dir, &settings).map_err(to_error)
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "zylara-skills-cmd-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("criar diretório temporário");
            Self { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Escreve `<root>/<name>/SKILL.md` e devolve o diretório da skill.
    fn write_skill(root: &Path, name: &str, description: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("criar diretório da skill");
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n# Instruções\n"),
        )
        .expect("escrever SKILL.md");
        dir
    }

    fn user_skill(temp: &TempDir, name: &str, description: &str) -> Skill {
        write_skill(&temp.path.join("skills"), name, description);
        let catalog = skills::catalog_with_roots(&temp.path, &[]).expect("catálogo");
        catalog
            .into_iter()
            .find(|skill| skill.name == name)
            .expect("skill do usuário no catálogo")
    }

    /// Cria um repositório externo falso (`<tmp>/external/<sub>/<nome>/SKILL.md`)
    /// e devolve o root correspondente para os helpers com roots injetáveis.
    fn external_root(
        temp: &TempDir,
        sub: &str,
        source: SkillSource,
        names: &[&str],
    ) -> ExternalSkillRoot {
        let dir = temp.path.join("external").join(sub);
        std::fs::create_dir_all(&dir).expect("criar repositório externo");
        for name in names {
            write_skill(&dir, name, &format!("Skill externa {name}."));
        }
        ExternalSkillRoot {
            source,
            dir,
            plugin_id: None,
        }
    }

    #[test]
    fn collect_reports_enabled_and_deletable_flags() {
        let temp = TempDir::new();
        user_skill(&temp, "alfa", "Skill do usuário.");
        let settings = Settings {
            disabled_skills: vec!["alfa".to_string(), "pdf".to_string()],
            ..Settings::default()
        };

        let summaries = collect_with_roots(&temp.path, &settings, &[]).expect("catálogo");
        let by_name = |name: &str| {
            summaries
                .iter()
                .find(|summary| summary.name == name)
                .unwrap_or_else(|| panic!("skill `{name}` ausente"))
        };

        let alfa = by_name("alfa");
        assert_eq!(alfa.source, "user");
        assert!(!alfa.enabled, "skill desativada deve vir com enabled=false");
        assert!(alfa.deletable, "skill do usuário é excluível");

        let pdf = by_name("pdf");
        assert_eq!(pdf.source, "bundled");
        assert!(!pdf.enabled, "skill embutida desativada");
        assert!(!pdf.deletable, "skill embutida não é excluível");

        // Uma skill não listada em disabled_skills fica ativa.
        let office = by_name("office-docx");
        assert!(office.enabled);
        assert!(!office.deletable);
    }

    #[test]
    fn toggle_adds_and_removes_without_duplicates() {
        let mut settings = Settings::default();
        assert!(toggle(&mut settings, "pdf", false));
        assert_eq!(settings.disabled_skills, vec!["pdf"]);
        // Idempotente: já desativada, nada muda.
        assert!(!toggle(&mut settings, "pdf", false));
        assert_eq!(settings.disabled_skills, vec!["pdf"]);

        assert!(toggle(&mut settings, "alfa", false));
        assert_eq!(settings.disabled_skills, vec!["alfa", "pdf"]);

        assert!(toggle(&mut settings, "pdf", true));
        assert_eq!(settings.disabled_skills, vec!["alfa"]);
        // Já ativa, nada muda.
        assert!(!toggle(&mut settings, "pdf", true));
        assert_eq!(settings.disabled_skills, vec!["alfa"]);

        // Nome vazio é ignorado.
        assert!(!toggle(&mut settings, "   ", false));
        assert_eq!(settings.disabled_skills, vec!["alfa"]);
    }

    #[test]
    fn toggle_trims_and_dedupes_existing_entries() {
        let mut settings = Settings {
            disabled_skills: vec![
                " zeta".to_string(),
                "alfa".to_string(),
                "alfa ".to_string(),
                String::new(),
            ],
            ..Settings::default()
        };
        // Desativar algo novo normaliza a lista inteira (trim + dedupe + sort).
        assert!(toggle(&mut settings, "beta", false));
        assert_eq!(settings.disabled_skills, vec!["alfa", "beta", "zeta"]);
    }

    #[test]
    fn removes_a_user_skill_directory() {
        let temp = TempDir::new();
        let skill = user_skill(&temp, "alfa", "Skill do usuário.");
        let dir = skill.dir.clone();
        assert!(dir.join("SKILL.md").is_file());

        remove_user_skill(&temp.path, &skill).expect("excluir skill do usuário");
        assert!(!dir.exists(), "diretório da skill deve sumir");
        assert!(
            temp.path.join("skills").is_dir(),
            "a pasta de skills do usuário permanece"
        );
    }

    #[test]
    fn refuses_to_remove_bundled_skills() {
        let temp = TempDir::new();
        let catalog = skills::catalog_with_roots(&temp.path, &[]).expect("catálogo");
        let pdf = catalog
            .iter()
            .find(|skill| skill.name == "pdf")
            .expect("skill embutida `pdf`");
        assert_eq!(pdf.source, SkillSource::Bundled);

        let error = remove_user_skill(&temp.path, pdf).expect_err("embutida não pode ser excluída");
        assert!(
            format!("{error:#}").contains("embutida"),
            "erro deve explicar que é embutida: {error:#}"
        );
        assert!(pdf.dir.join("SKILL.md").is_file(), "skill embutida intacta");
    }

    #[test]
    fn collect_includes_external_skills_as_read_only() {
        let temp = TempDir::new();
        user_skill(&temp, "alfa", "Skill do usuário.");
        let roots = vec![
            external_root(&temp, "codex", SkillSource::Codex, &["beta", "alfa"]),
            external_root(&temp, "agents", SkillSource::Agents, &["gama"]),
        ];
        let settings = Settings {
            disabled_skills: vec!["beta".to_string()],
            ..Settings::default()
        };

        let summaries = collect_with_roots(&temp.path, &settings, &roots).expect("catálogo");
        let by_name = |name: &str| {
            summaries
                .iter()
                .find(|summary| summary.name == name)
                .unwrap_or_else(|| panic!("skill `{name}` ausente"))
        };

        let beta = by_name("beta");
        assert_eq!(beta.source, "codex");
        assert!(!beta.enabled, "skill externa desativada");
        assert!(!beta.deletable, "skill externa é somente leitura");

        let gama = by_name("gama");
        assert_eq!(gama.source, "agents");
        assert!(gama.enabled);
        assert!(!gama.deletable, "skill externa é somente leitura");

        // Precedência: a skill do Zylara vence a externa de mesmo nome.
        let alfa = by_name("alfa");
        assert_eq!(alfa.source, "user");
        assert!(alfa.deletable);
    }

    #[test]
    fn toggle_works_for_external_skills() {
        let temp = TempDir::new();
        let roots = vec![external_root(
            &temp,
            "codex",
            SkillSource::Codex,
            &["beta"],
        )];
        let mut settings = Settings::default();

        // Desativar uma externa persiste o nome em `disabled_skills`.
        assert!(toggle(&mut settings, "beta", false));
        assert_eq!(settings.disabled_skills, vec!["beta"]);
        let summaries = collect_with_roots(&temp.path, &settings, &roots).expect("catálogo");
        let beta = summaries
            .iter()
            .find(|summary| summary.name == "beta")
            .expect("beta listada");
        assert!(!beta.enabled);
        assert!(!beta.deletable);

        // Reativar remove da lista e o catálogo reflete.
        assert!(toggle(&mut settings, "beta", true));
        assert!(settings.disabled_skills.is_empty());
        let summaries = collect_with_roots(&temp.path, &settings, &roots).expect("catálogo");
        let beta = summaries
            .iter()
            .find(|summary| summary.name == "beta")
            .expect("beta listada");
        assert!(beta.enabled);
    }

    #[test]
    fn refuses_to_remove_external_skills() {
        let temp = TempDir::new();
        let roots = vec![external_root(
            &temp,
            "codex",
            SkillSource::Codex,
            &["beta"],
        )];
        let skill =
            find_skill_with_roots(&temp.path, "beta", &roots).expect("skill externa no catálogo");
        assert_eq!(skill.source, SkillSource::Codex);
        let dir = skill.dir.clone();

        let error = remove_user_skill(&temp.path, &skill).expect_err("externa é somente leitura");
        let message = format!("{error:#}");
        assert!(
            message.contains("somente leitura"),
            "erro deve dizer que é somente leitura: {message}"
        );
        assert!(
            message.contains("codex"),
            "erro deve citar a origem da skill: {message}"
        );
        assert!(
            dir.join("SKILL.md").is_file(),
            "repositório externo intacto após a recusa"
        );
    }

    #[test]
    fn refuses_directories_outside_the_user_skills_dir() {
        let temp = TempDir::new();
        // A pasta de skills do usuário existe; o alvo do teste fica fora dela.
        std::fs::create_dir_all(temp.path.join("skills")).expect("criar pasta de skills");
        let outside = temp.path.join("fora");
        std::fs::create_dir_all(&outside).expect("criar diretório fora");
        std::fs::write(outside.join("SKILL.md"), "---\nname: fora\n---\n").expect("SKILL.md");
        let skill = Skill {
            name: "fora".to_string(),
            description: "fora".to_string(),
            body: String::new(),
            dir: outside.clone(),
            source: SkillSource::User,
            plugin_id: None,
        };

        let error = remove_user_skill(&temp.path, &skill).expect_err("caminho fora é recusado");
        assert!(
            format!("{error:#}").contains("filho direto"),
            "erro deve citar filho direto: {error:#}"
        );
        assert!(outside.is_dir(), "nada fora da pasta de skills é apagado");
    }

    #[test]
    fn refuses_a_missing_skill_directory() {
        let temp = TempDir::new();
        std::fs::create_dir_all(temp.path.join("skills")).expect("criar pasta de skills");
        let skill = Skill {
            name: "fantasma".to_string(),
            description: String::new(),
            body: String::new(),
            dir: temp.path.join("skills").join("fantasma"),
            source: SkillSource::User,
            plugin_id: None,
        };
        assert!(remove_user_skill(&temp.path, &skill).is_err());
    }

    #[test]
    fn content_of_maps_user_skill_metadata_and_body() {
        let temp = TempDir::new();
        let skill = user_skill(&temp, "alfa", "Skill do usuário.");

        let content = content_of(&skill);
        assert_eq!(content.name, "alfa");
        assert_eq!(content.description, "Skill do usuário.");
        assert_eq!(content.source, "user");
        assert_eq!(Path::new(&content.dir), skill.dir.as_path());
        // O corpo vem do Markdown após o frontmatter, sem metadados junto.
        assert_eq!(content.content, skill.body);
        assert!(
            content.content.contains("# Instruções"),
            "corpo deve trazer o Markdown: {}",
            content.content
        );
        assert!(
            !content.content.contains("description:"),
            "frontmatter não entra no content: {}",
            content.content
        );
        assert!(
            !content.content.starts_with("---"),
            "content não deve começar com o delimitador do frontmatter"
        );
    }

    #[test]
    fn content_of_keeps_bundled_skill_body() {
        let temp = TempDir::new();
        let catalog = skills::catalog_with_roots(&temp.path, &[]).expect("catálogo");
        let pdf = catalog
            .iter()
            .find(|skill| skill.name == "pdf")
            .expect("skill embutida `pdf`");

        let content = content_of(pdf);
        assert_eq!(content.name, "pdf");
        assert_eq!(content.source, "bundled");
        assert!(
            !content.description.trim().is_empty(),
            "descrição da skill embutida"
        );
        assert!(
            !content.content.trim().is_empty(),
            "corpo da skill embutida não pode ser vazio"
        );
        assert_eq!(Path::new(&content.dir), pdf.dir.as_path());
        assert!(
            !content.content.contains("description:"),
            "frontmatter não entra no content"
        );
    }

    #[test]
    fn find_skill_resolves_user_skill_by_name() {
        let temp = TempDir::new();
        let written = user_skill(&temp, "alfa", "Skill do usuário.");

        // O nome é resolvido após trim (o frontmatter define o nome canônico).
        let skill = find_skill(&temp.path, "  alfa  ").expect("skill do usuário");
        assert_eq!(skill.name, "alfa");
        assert_eq!(skill.source, SkillSource::User);
        assert!(written.dir.join("SKILL.md").is_file());

        let content = content_of(&skill);
        assert!(content.content.contains("# Instruções"));
        assert_eq!(Path::new(&content.dir), skill.dir.as_path());
    }

    #[test]
    fn find_skill_reports_unknown_and_empty_names() {
        let temp = TempDir::new();
        std::fs::create_dir_all(temp.path.join("skills")).expect("criar pasta de skills");

        let unknown = find_skill(&temp.path, "nao-existe-xyz").expect_err("nome desconhecido");
        let message = to_error(unknown);
        assert!(
            message.contains("não encontrada"),
            "erro deve citar skill não encontrada: {message}"
        );

        for name in ["", "   "] {
            let empty = find_skill(&temp.path, name).expect_err("nome vazio");
            let message = to_error(empty);
            assert!(
                message.contains("obrigatório"),
                "erro deve citar nome obrigatório: {message}"
            );
        }
    }

    #[test]
    fn content_of_keeps_external_skill_source() {
        let temp = TempDir::new();
        let roots = vec![external_root(
            &temp,
            "codex",
            SkillSource::Codex,
            &["beta"],
        )];
        let skill =
            find_skill_with_roots(&temp.path, "beta", &roots).expect("skill externa no catálogo");
        assert_eq!(skill.source, SkillSource::Codex);

        let content = content_of(&skill);
        assert_eq!(content.name, "beta");
        assert_eq!(content.source, "codex");
        assert_eq!(content.description, "Skill externa beta.");
        assert_eq!(Path::new(&content.dir), skill.dir.as_path());
        assert!(
            content.content.contains("# Instruções"),
            "corpo da skill externa: {}",
            content.content
        );
    }

    /// Criar symlink no Windows exige privilégio; o teste é pulado quando o SO
    /// recusa (mesmo padrão dos testes que dependem de Python/Node no PATH).
    #[test]
    fn refuses_symlinked_skill_directories() {
        let temp = TempDir::new();
        let target = user_skill(&temp, "vitima", "Skill real.");
        let target_dir = target.dir.clone();
        let link = temp.path.join("skills").join("link");

        #[cfg(unix)]
        let created = std::os::unix::fs::symlink(&target_dir, &link).is_ok();
        #[cfg(windows)]
        let created = std::os::windows::fs::symlink_dir(&target_dir, &link).is_ok();
        #[cfg(not(any(unix, windows)))]
        let created = false;

        if !created {
            eprintln!("symlink não suportado neste ambiente; teste pulado");
            return;
        }

        let skill = Skill {
            name: "link".to_string(),
            description: String::new(),
            body: String::new(),
            dir: link,
            source: SkillSource::User,
            plugin_id: None,
        };
        let error = remove_user_skill(&temp.path, &skill).expect_err("symlink é recusado");
        assert!(
            format!("{error:#}").contains("link simbólico"),
            "erro deve citar link simbólico: {error:#}"
        );
        assert!(
            target_dir.join("SKILL.md").is_file(),
            "alvo do link intacto"
        );
    }
}
