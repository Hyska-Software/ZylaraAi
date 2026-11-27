//! Confinamento de paths ao workspace.
//!
//! Contrato em `docs/goals/code-harness/HARNESS.md` §7.2. Regras:
//! - rejeita caminho vazio, NUL e device paths (`\\?\`, `\\.\`);
//! - canonicaliza o ancestral existente mais próximo (resolve symlink/junction) e exige
//!   que o resultado esteja dentro do root canônico (case-insensitive no Windows);
//! - para escrita, o arquivo pode não existir, mas nenhum componente existente pode
//!   apontar para fora do root;
//! - devolve o path absoluto (para IO); a UI recebe caminhos relativos com `/`.

#![allow(dead_code)]

use std::fmt;
use std::path::{Component, Path, PathBuf};

pub const FS_EMPTY_PATH: &str = "FS_EMPTY_PATH";
pub const FS_OUTSIDE_WORKSPACE: &str = "FS_OUTSIDE_WORKSPACE";
pub const FS_NOT_FOUND: &str = "FS_NOT_FOUND";
pub const FS_NOT_A_FILE: &str = "FS_NOT_A_FILE";
pub const FS_INVALID_PATH: &str = "FS_INVALID_PATH";

/// Erro de filesystem com código estável (o modelo e a UI dependem do código).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
}

impl FsError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FsError {}

/// Acesso requerido ao path (leitura valida existência; escrita valida o pai).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Leitura de **arquivo** (diretório vira `FS_NOT_A_FILE`).
    Read,
    /// Leitura de **diretório** (listagem de árvore; arquivo vira
    /// `FS_NOT_A_FILE`). Existe porque listar `.` é uma operação válida.
    ReadDir,
    Write,
    /// Mutation of an existing file **or** directory (rename/copy/delete/reveal).
    /// `Write` is intentionally not reused: it rejects existing directories.
    Mutate,
}

/// Resolve `requested` contra `root`, garantindo que o resultado não escapa do workspace.
///
/// `root` precisa existir e ser um diretório; `requested` pode ser relativo ou absoluto.
pub fn resolve(root: &Path, requested: &str, access: Access) -> Result<PathBuf, FsError> {
    resolve_with_confinement(root, requested, access, true)
}

/// Resolves a path under `root` without requiring it to stay inside the
/// workspace. Used by agents without a project folder: the agent scratch
/// directory is the base for relative paths, but absolute paths anywhere on
/// the machine are readable. Validation (device paths, NUL, type) still runs.
pub fn resolve_unconfined(root: &Path, requested: &str, access: Access) -> Result<PathBuf, FsError> {
    resolve_with_confinement(root, requested, access, false)
}

fn resolve_with_confinement(
    root: &Path,
    requested: &str,
    access: Access,
    confined: bool,
) -> Result<PathBuf, FsError> {
    let requested = requested.trim();
    if requested.is_empty() {
        return Err(FsError::new(FS_EMPTY_PATH, "informe um caminho"));
    }
    if requested.contains('\0') {
        return Err(FsError::new(FS_INVALID_PATH, "caminho contém NUL"));
    }
    if is_device_path(requested) {
        return Err(FsError::new(
            FS_INVALID_PATH,
            "caminhos de dispositivo (\\\\?\\ / \\\\.\\) não são permitidos",
        ));
    }

    let root_canon = simplify_verbatim(&dunce::canonicalize(root).map_err(|e| {
        FsError::new(
            FS_NOT_FOUND,
            format!("workspace indisponível ({}): {e}", root.display()),
        )
    })?);
    if !root_canon.is_dir() {
        return Err(FsError::new(
            FS_NOT_A_FILE,
            "o root do workspace não é um diretório",
        ));
    }

    let raw = Path::new(requested);
    reject_drive_relative(raw)?;

    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root_canon.join(raw)
    };
    let normalized = normalize_lexically(&joined)?;

    // Canonicaliza o ancestral existente mais próximo: é ele que resolve symlinks/junctions.
    // Componentes que ainda não existem não podem ser links, então basta reanexá-los.
    let (existing, rest) = split_existing_ancestor(&normalized);
    let existing_canon = simplify_verbatim(&dunce::canonicalize(&existing).map_err(|e| {
        FsError::new(
            FS_NOT_FOUND,
            format!("caminho inexistente ({}): {e}", existing.display()),
        )
    })?);
    let mut candidate = existing_canon;
    for part in rest.iter().rev() {
        candidate.push(part);
    }

    if confined && !is_within(&root_canon, &candidate) {
        return Err(FsError::new(
            FS_OUTSIDE_WORKSPACE,
            format!("'{requested}' está fora do workspace"),
        ));
    }

    match access {
        Access::Read => {
            if !candidate.exists() {
                return Err(FsError::new(
                    FS_NOT_FOUND,
                    format!("arquivo não encontrado: {requested}"),
                ));
            }
            if candidate.is_dir() {
                return Err(FsError::new(
                    FS_NOT_A_FILE,
                    format!("'{requested}' é um diretório"),
                ));
            }
        }
        Access::ReadDir => {
            if !candidate.exists() {
                return Err(FsError::new(
                    FS_NOT_FOUND,
                    format!("pasta não encontrada: {requested}"),
                ));
            }
            if !candidate.is_dir() {
                return Err(FsError::new(
                    FS_NOT_A_FILE,
                    format!("'{requested}' não é um diretório"),
                ));
            }
        }
        Access::Write => {
            if candidate.exists() && candidate.is_dir() {
                return Err(FsError::new(
                    FS_NOT_A_FILE,
                    format!("'{requested}' é um diretório"),
                ));
            }
            if candidate.parent().is_none() {
                return Err(FsError::new(FS_INVALID_PATH, "caminho sem diretório pai"));
            }
        }
        Access::Mutate => {
            if !candidate.exists() {
                return Err(FsError::new(
                    FS_NOT_FOUND,
                    format!("caminho inexistente: {requested}"),
                ));
            }
            if candidate.parent().is_none() {
                return Err(FsError::new(FS_INVALID_PATH, "caminho sem diretório pai"));
            }
        }
    }

    Ok(candidate)
}

/// `true` quando `candidate` é `root` ou está dentro dele (case-insensitive no Windows).
pub fn is_within(root: &Path, candidate: &Path) -> bool {
    let root = canonical_or_lexical(root);
    let candidate = canonical_or_lexical(candidate);
    let mut root_parts = root.components();
    let mut cand_parts = candidate.components();
    loop {
        match (root_parts.next(), cand_parts.next()) {
            (None, _) => return true,
            (Some(expected), Some(actual)) => {
                if !component_eq(expected, actual) {
                    return false;
                }
            }
            (Some(_), None) => return false,
        }
    }
}

/// Caminho relativo ao root com separador `/` (vazio quando `path == root`).
pub fn to_relative(root: &Path, path: &Path) -> String {
    let root = canonical_or_lexical(root);
    let path = canonical_or_lexical(path);
    let rel = path
        .strip_prefix(&root)
        .map(Path::to_path_buf)
        .or_else(|_| strip_prefix_case_insensitive(&root, &path))
        .unwrap_or_else(|_| path.clone());
    rel.components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

fn is_device_path(requested: &str) -> bool {
    // Windows aceita `/` como separador; normaliza só para o teste de prefixo.
    let normalized = requested.replace('/', "\\");
    normalized.starts_with("\\\\?\\") || normalized.starts_with("\\\\.\\")
}

#[cfg(windows)]
fn reject_drive_relative(path: &Path) -> Result<(), FsError> {
    let mut parts = path.components();
    if parts.next().is_some() {
        // Prefixo de drive seguido de RootDir é um caminho absoluto normal; prefixo sem
        // RootDir (`C:foo`) é relativo ao diretório corrente do drive: recusamos.
        if !matches!(parts.clone().next(), Some(Component::RootDir)) {
            // Só é drive-relativo quando há Prefix como primeiro componente.
            let first = path.components().next();
            if matches!(first, Some(Component::Prefix(_))) {
                return Err(FsError::new(
                    FS_INVALID_PATH,
                    "caminho relativo a drive (ex.: 'C:pasta') não é suportado",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn reject_drive_relative(_path: &Path) -> Result<(), FsError> {
    Ok(())
}

/// Normaliza `.`/`..`/separadores sem tocar no disco.
fn normalize_lexically(path: &Path) -> Result<PathBuf, FsError> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir => out.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err(FsError::new(
                        FS_OUTSIDE_WORKSPACE,
                        "o caminho escapa do workspace",
                    ));
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Ok(out)
}

/// Separa o path em (ancestral existente mais próximo, componentes restantes).
/// Os restantes voltam na ordem do path; o chamador reanexa em `.rev()`.
fn split_existing_ancestor(path: &Path) -> (PathBuf, Vec<std::ffi::OsString>) {
    let mut current = path.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if current.exists() {
            return (current, rest);
        }
        match (current.file_name().map(|n| n.to_os_string()), current.parent()) {
            (Some(name), Some(parent)) if parent != current => {
                rest.push(name);
                current = parent.to_path_buf();
            }
            _ => return (current, rest),
        }
    }
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    let resolved = dunce::canonicalize(path).unwrap_or_else(|_| {
        normalize_lexically(path).unwrap_or_else(|_| path.to_path_buf())
    });
    simplify_verbatim(&resolved)
}

/// Remove o prefixo verbatim `\\?\` (e converte `\\?\UNC\` de volta para UNC).
///
/// `dunce` preserva o prefixo quando o caminho resultante não é seguro para APIs
/// legadas — em particular em caminhos > 260 chars. Para comparar paths (prefixo do
/// workspace) precisamos da forma "humana"; o IO continua funcionando porque o Rust
/// adiciona o prefixo verbatim sozinho quando necessário.
fn simplify_verbatim(path: &Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

#[cfg(windows)]
fn component_eq(a: Component<'_>, b: Component<'_>) -> bool {
    let a = a.as_os_str().to_string_lossy();
    let b = b.as_os_str().to_string_lossy();
    a.eq_ignore_ascii_case(&b)
}

#[cfg(not(windows))]
fn component_eq(a: Component<'_>, b: Component<'_>) -> bool {
    a.as_os_str() == b.as_os_str()
}

fn strip_prefix_case_insensitive(root: &Path, path: &Path) -> Result<PathBuf, ()> {
    let root_parts: Vec<_> = root.components().collect();
    let path_parts: Vec<_> = path.components().collect();
    if path_parts.len() < root_parts.len() {
        return Err(());
    }
    for (expected, actual) in root_parts.iter().zip(path_parts.iter()) {
        if !component_eq(*expected, *actual) {
            return Err(());
        }
    }
    let mut out = PathBuf::new();
    for part in &path_parts[root_parts.len()..] {
        out.push(part.as_os_str());
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* Testes                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("criar workspace");
        (temp, root)
    }

    fn err_code(result: Result<PathBuf, FsError>) -> &'static str {
        result.expect_err("esperava erro").code
    }

    #[test]
    fn rejects_empty_nul_and_device_paths() {
        let (_temp, root) = workspace();
        assert_eq!(err_code(resolve(&root, "   ", Access::Read)), FS_EMPTY_PATH);
        assert_eq!(err_code(resolve(&root, "a\0b", Access::Read)), FS_INVALID_PATH);
        assert_eq!(
            err_code(resolve(&root, "\\\\?\\C:\\Windows\\win.ini", Access::Read)),
            FS_INVALID_PATH
        );
        assert_eq!(
            err_code(resolve(&root, "\\\\.\\NUL", Access::Read)),
            FS_INVALID_PATH
        );
    }

    #[test]
    fn rejects_parent_escape() {
        let (temp, root) = workspace();
        fs::write(temp.path().join("fora.txt"), "x").expect("criar fora");
        assert_eq!(
            err_code(resolve(&root, "../fora.txt", Access::Read)),
            FS_OUTSIDE_WORKSPACE
        );
        assert_eq!(
            err_code(resolve(&root, "sub/../../fora.txt", Access::Read)),
            FS_OUTSIDE_WORKSPACE
        );
    }

    #[test]
    fn accepts_relative_and_absolute_inside() {
        let (_temp, root) = workspace();
        fs::write(root.join("a.txt"), "ok").expect("criar a");
        let relative = resolve(&root, "a.txt", Access::Read).expect("relativo");
        let absolute = resolve(&root, &root.join("a.txt").to_string_lossy(), Access::Read)
            .expect("absoluto");
        assert_eq!(relative, absolute);
        assert!(relative.exists());
    }

    #[test]
    fn rejects_absolute_outside_and_missing() {
        let (temp, root) = workspace();
        let outside = temp.path().join("fora.txt");
        fs::write(&outside, "x").expect("criar fora");
        assert_eq!(
            err_code(resolve(&root, &outside.to_string_lossy(), Access::Read)),
            FS_OUTSIDE_WORKSPACE
        );
        assert_eq!(
            err_code(resolve(&root, "nao-existe.txt", Access::Read)),
            FS_NOT_FOUND
        );
        fs::create_dir_all(root.join("sub")).expect("criar sub");
        assert_eq!(err_code(resolve(&root, "sub", Access::Read)), FS_NOT_A_FILE);
    }

    #[test]
    fn unconfined_allows_outside_paths_but_keeps_validation() {
        let (temp, root) = workspace();
        let outside = temp.path().join("fora.txt");
        fs::write(&outside, "x").expect("criar fora");
        let resolved = resolve_unconfined(&root, &outside.to_string_lossy(), Access::Read)
            .expect("absolute outside is readable");
        let canonical = simplify_verbatim(&outside.canonicalize().expect("canonical outside"));
        assert_eq!(resolved, canonical);
        let parent_escape = resolve_unconfined(&root, "../fora.txt", Access::Read)
            .expect("relative escape is allowed");
        assert_eq!(parent_escape, canonical);
        assert_eq!(
            err_code(resolve_unconfined(&root, "nao-existe.txt", Access::Read)),
            FS_NOT_FOUND
        );
        fs::create_dir_all(root.join("sub")).expect("criar sub");
        assert_eq!(
            err_code(resolve_unconfined(&root, "sub", Access::Read)),
            FS_NOT_A_FILE
        );
    }

    #[test]
    fn read_dir_allows_directories_and_still_confines_them() {
        let (temp, root) = workspace();
        fs::create_dir_all(root.join("src")).expect("criar src");
        fs::write(root.join("src").join("app.ts"), "x").expect("criar arquivo");
        fs::write(root.join("a.txt"), "ok").expect("criar a");

        // Regressão da aba Arquivos: listar o próprio root (".") é válido.
        let base = resolve(&root, ".", Access::ReadDir).expect("root é diretório");
        assert!(base.is_dir());
        let nested = resolve(&root, "src", Access::ReadDir).expect("src é diretório");
        assert!(nested.is_dir());
        assert_eq!(to_relative(&root, &nested), "src");

        // Arquivo continua recusado na leitura de diretório e Read continua só arquivo.
        assert_eq!(err_code(resolve(&root, "a.txt", Access::ReadDir)), FS_NOT_A_FILE);
        assert_eq!(err_code(resolve(&root, "src", Access::Read)), FS_NOT_A_FILE);
        assert_eq!(
            err_code(resolve(&root, "nao-existe", Access::ReadDir)),
            FS_NOT_FOUND
        );

        // Confinamento continua valendo para diretórios.
        fs::create_dir_all(temp.path().join("fora")).expect("criar fora");
        assert_eq!(
            err_code(resolve(&root, "../fora", Access::ReadDir)),
            FS_OUTSIDE_WORKSPACE
        );
    }

    #[test]
    fn write_allows_new_nested_file() {
        let (_temp, root) = workspace();
        let target = resolve(&root, "novo/dir/arquivo.txt", Access::Write)
            .expect("escrita deve permitir arquivo novo");
        assert_eq!(to_relative(&root, &target), "novo/dir/arquivo.txt");
        fs::create_dir_all(target.parent().expect("pai")).expect("criar dirs");
        fs::write(&target, "conteúdo").expect("escrever");
        let read_back = resolve(&root, "novo/dir/arquivo.txt", Access::Read).expect("leitura");
        assert_eq!(target, read_back);
    }

    #[test]
    fn mutate_allows_existing_file_and_directory_but_not_missing() {
        let (temp, root) = workspace();
        let file = root.join("a.txt");
        fs::write(&file, "x").expect("criar arquivo");
        fs::create_dir_all(root.join("dir")).expect("criar diretório");

        assert_eq!(resolve(&root, "a.txt", Access::Mutate).expect("arquivo"), file);
        assert_eq!(
            resolve(&root, "dir", Access::Mutate).expect("diretório"),
            root.join("dir")
        );
        assert_eq!(err_code(resolve(&root, "missing", Access::Mutate)), FS_NOT_FOUND);
        assert_eq!(
            err_code(resolve(&root, "../a.txt", Access::Mutate)),
            FS_OUTSIDE_WORKSPACE
        );
        assert!(!temp.path().join("a.txt").exists());
    }

    #[test]
    fn is_case_insensitive_but_keeps_disk_case() {
        let (_temp, root) = workspace();
        fs::create_dir_all(root.join("Sub")).expect("criar Sub");
        fs::write(root.join("Sub").join("File.TXT"), "x").expect("criar arquivo");
        let resolved = resolve(&root, "sub/file.txt", Access::Read).expect("case-insensitive");
        assert!(resolved.exists());
        assert!(to_relative(&root, &resolved).eq_ignore_ascii_case("Sub/File.TXT"));
    }

    #[test]
    fn accepts_unicode_and_spaces() {
        let (_temp, root) = workspace();
        let file = root.join("pasta com espaço").join("çãó.txt");
        fs::create_dir_all(file.parent().expect("pai")).expect("criar pasta");
        fs::write(&file, "x").expect("criar arquivo");
        let resolved = resolve(&root, "pasta com espaço/çãó.txt", Access::Read).expect("unicode");
        assert_eq!(resolved, file);
    }

    #[test]
    fn is_within_and_to_relative() {
        let (temp, root) = workspace();
        let file = root.join("dir").join("a.txt");
        fs::create_dir_all(file.parent().expect("pai")).expect("criar dir");
        fs::write(&file, "x").expect("criar arquivo");
        assert!(is_within(&root, &file));
        assert!(!is_within(&root, &temp.path().join("fora.txt")));
        assert_eq!(to_relative(&root, &file), "dir/a.txt");
        assert_eq!(to_relative(&root, &root), "");
    }

    #[cfg(windows)]
    #[test]
    fn rejects_drive_relative_path() {
        let (_temp, root) = workspace();
        assert_eq!(
            err_code(resolve(&root, "C:relativo.txt", Access::Read)),
            FS_INVALID_PATH
        );
    }

    #[test]
    fn rejects_symlink_or_junction_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        let outside = temp.path().join("fora");
        fs::create_dir_all(&root).expect("ws");
        fs::create_dir_all(&outside).expect("fora");
        fs::write(outside.join("segredo.txt"), "x").expect("arq fora");

        let link = root.join("link");
        if !create_dir_link(&outside, &link) {
            eprintln!("symlink/junction indisponível neste ambiente: teste ignorado");
            return;
        }
        assert_eq!(
            err_code(resolve(&root, "link/segredo.txt", Access::Read)),
            FS_OUTSIDE_WORKSPACE
        );
        assert_eq!(
            err_code(resolve(&root, "link/novo.txt", Access::Write)),
            FS_OUTSIDE_WORKSPACE
        );
    }

    fn create_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return true;
            }
            // Junction não exige Developer Mode/admin.
            let status = std::process::Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    &link.to_string_lossy(),
                    &target.to_string_lossy(),
                ])
                .output();
            return matches!(status, Ok(out) if out.status.success());
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn long_path_inside_root() {
        let (_temp, root) = workspace();
        let component = "diretorio-com-nome-bem-longo-para-testar-caminhos";
        let mut path = root.clone();
        for _ in 0..6 {
            path.push(component);
        }
        if fs::create_dir_all(&path).is_err() {
            eprintln!("long paths indisponíveis neste ambiente: teste ignorado");
            return;
        }
        fs::write(path.join("arquivo.txt"), "x").expect("criar arquivo");
        let relative = format!(
            "{}/{}/{}/{}/{}/{}/arquivo.txt",
            component, component, component, component, component, component
        );
        let resolved = resolve(&root, &relative, Access::Read).expect("path longo dentro do root");
        assert!(resolved.exists());
        assert!(resolved.to_string_lossy().len() > 260);
    }
}
