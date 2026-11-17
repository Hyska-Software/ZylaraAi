//! Journal de alterações e object store de checkpoints.
//!
//! Contrato em `docs/goals/code-harness/HARNESS.md` §7.4. O object store guarda o
//! conteúdo anterior de cada arquivo mutado (dedupe por sha256) para permitir reverter
//! turno/arquivo; o journal registra o diff por linhas do que mudou no turno.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use similar::{ChangeTag, TextDiff};

/// Objetos acima disso não entram no store (o journal registra "arquivo grande").
pub const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024;

/// Object store content-addressed: `<root>/<2 primeiros hex>/<sha256>`.
#[derive(Debug, Clone)]
pub struct ObjectStore {
    pub root: PathBuf,
}

impl ObjectStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Grava bytes e devolve o sha256 hex (dedupe: mesmo conteúdo = mesmo arquivo).
    pub fn put_bytes(&self, bytes: &[u8]) -> io::Result<String> {
        let hash = sha256_hex(bytes);
        let path = self.object_path(&hash)?;
        if path.exists() {
            return Ok(hash);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Escrita atômica: temp no mesmo diretório e rename. Se outra thread ganhar a
        // corrida, o conteúdo é idêntico (hash), então basta descartar o temp.
        // O nome precisa ser único por publicação: duas sessões paralelas
        // podem tentar gravar o mesmo objeto ao mesmo tempo.
        let temp = path.with_file_name(format!(
            ".tmp-{hash}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&temp, bytes)?;
        match std::fs::rename(&temp, &path) {
            Ok(()) => Ok(hash),
            Err(error) if path.exists() => {
                let _ = std::fs::remove_file(&temp);
                let _ = error;
                Ok(hash)
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temp);
                Err(error)
            }
        }
    }

    /// Lê um objeto pelo hash. Rejeita hash malformado (anti path traversal).
    pub fn get(&self, hash: &str) -> io::Result<Vec<u8>> {
        std::fs::read(self.object_path(hash)?)
    }

    /// Captura um arquivo pequeno (≤ [`MAX_OBJECT_BYTES`]); `None` se for grande/ausente.
    pub fn put_file(&self, path: &Path) -> io::Result<Option<String>> {
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file() || metadata.len() > MAX_OBJECT_BYTES {
            return Ok(None);
        }
        let bytes = std::fs::read(path)?;
        Ok(Some(self.put_bytes(&bytes)?))
    }

    /// Remove objetos mais antigos que `days`; devolve quantos foram removidos.
    pub fn prune_older_than(&self, days: u64) -> io::Result<usize> {
        let max_age = Duration::from_secs(days.saturating_mul(24 * 60 * 60));
        let now = SystemTime::now();
        let mut removed = 0usize;
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Ok(0);
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                // Temp órfão de escrita interrompida: também expira.
                if is_temporary(&path) && is_older_than(&path, now, max_age) {
                    if std::fs::remove_file(&path).is_ok() {
                        removed += 1;
                    }
                }
                continue;
            }
            let Ok(objects) = std::fs::read_dir(&path) else {
                continue;
            };
            let mut empty = true;
            for object in objects.flatten() {
                empty = false;
                let object_path = object.path();
                if !object_path.is_file() {
                    continue;
                }
                if is_older_than(&object_path, now, max_age)
                    && std::fs::remove_file(&object_path).is_ok()
                {
                    removed += 1;
                }
            }
            if empty {
                let _ = std::fs::remove_dir(&path);
            }
        }
        Ok(removed)
    }

    fn object_path(&self, hash: &str) -> io::Result<PathBuf> {
        if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "hash de objeto inválido",
            ));
        }
        let normalized = hash.to_ascii_lowercase();
        Ok(self
            .root
            .join(&normalized[..2])
            .join(&normalized))
    }
}

/// Arquivo alterado em um turno (para o painel Alterações e para reverter).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileCapture {
    /// Path relativo ao workspace, com `/`.
    pub path: String,
    /// created | modified | deleted.
    pub change: String,
    pub before_hash: Option<String>,
    pub after_hash: Option<String>,
    pub added: u32,
    pub removed: u32,
    pub diff: Option<String>,
}

/// `(added, removed)` por linhas entre dois conteúdos (created/deleted usam `None`).
pub fn line_stats(before: Option<&[u8]>, after: Option<&[u8]>) -> (u32, u32) {
    let before = before
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let after = after
        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        .unwrap_or_default();
    let diff = TextDiff::from_lines(&before, &after);
    let mut added = 0u32;
    let mut removed = 0u32;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    (added, removed)
}

/// Diff unificado (contexto 3) com cabeçalhos `--- a/<path>` / `+++ b/<path>`.
pub fn unified_diff(path: &str, before: &str, after: &str) -> String {
    let diff = TextDiff::from_lines(before, after);
    let from = format!("--- a/{path}");
    let to = format!("+++ b/{path}");
    diff.unified_diff()
        .context_radius(3)
        .header(&from, &to)
        .to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn is_temporary(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().starts_with(".tmp-"))
        .unwrap_or(false)
}

fn is_older_than(path: &Path, now: SystemTime, max_age: Duration) -> bool {
    let Ok(modified) = std::fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };
    match now.duration_since(modified) {
        Ok(age) => age > max_age,
        Err(_) => false,
    }
}

/// Ring buffer simples usado pelo journal quando o diff é grande demais.
pub fn tail_lines(content: &str, max_lines: usize) -> String {
    let mut lines: VecDeque<&str> = VecDeque::with_capacity(max_lines.min(1024));
    for line in content.lines() {
        if lines.len() == max_lines {
            lines.pop_front();
        }
        lines.push_back(line);
    }
    lines.into_iter().collect::<Vec<_>>().join("\n")
}

/* ------------------------------------------------------------------ */
/* Testes                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store() -> (tempfile::TempDir, ObjectStore) {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ObjectStore::new(temp.path().join("objects"));
        (temp, store)
    }

    #[test]
    fn put_get_roundtrip_and_dedupe() {
        let (_temp, store) = store();
        let hash = store.put_bytes(b"conteudo").expect("put");
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let again = store.put_bytes(b"conteudo").expect("put dedupe");
        assert_eq!(hash, again);
        assert_eq!(store.get(&hash).expect("get"), b"conteudo");
        // Um único objeto gravado.
        let files = count_files(&store.root);
        assert_eq!(files, 1);
    }

    #[test]
    fn put_file_small_and_large() {
        let (temp, store) = store();
        let small = temp.path().join("small.txt");
        fs::write(&small, "abc").expect("small");
        let hash = store.put_file(&small).expect("put_file").expect("hash");
        assert_eq!(store.get(&hash).expect("get"), b"abc");

        let large = temp.path().join("large.bin");
        fs::write(&large, vec![b'x'; (MAX_OBJECT_BYTES + 1) as usize]).expect("large");
        assert!(store.put_file(&large).expect("put_file grande").is_none());
    }

    #[test]
    fn get_rejects_malformed_hash() {
        let (_temp, store) = store();
        assert!(store.get("../escape").is_err());
        assert!(store.get("nao-hex").is_err());
    }

    #[test]
    fn line_stats_created_modified_deleted() {
        assert_eq!(line_stats(None, Some(b"a\nb\n")), (2, 0));
        assert_eq!(line_stats(Some(b"a\nb\n"), None), (0, 2));
        assert_eq!(line_stats(Some(b"a\nb\n"), Some(b"a\nc\n")), (1, 1));
        assert_eq!(line_stats(Some(b"a\n"), Some(b"a\n")), (0, 0));
        // Conteúdo binário não quebra: decodifica com perdas.
        assert_eq!(line_stats(Some(&[0xff, 0xfe]), Some(&[0xff, 0xfe])), (0, 0));
    }

    #[test]
    fn unified_diff_has_headers_and_changes() {
        let diff = unified_diff("src/x.txt", "a\nb\n", "a\nc\n");
        assert!(diff.contains("--- a/src/x.txt"), "diff: {diff}");
        assert!(diff.contains("+++ b/src/x.txt"), "diff: {diff}");
        assert!(diff.contains("-b"), "diff: {diff}");
        assert!(diff.contains("+c"), "diff: {diff}");
        assert!(unified_diff("x", "igual\n", "igual\n").is_empty());
    }

    #[test]
    fn prune_removes_objects_by_age() {
        let (_temp, store) = store();
        let hash = store.put_bytes(b"antigo").expect("put");
        assert_eq!(store.prune_older_than(1).expect("prune"), 0);
        assert!(store.get(&hash).is_ok());
        assert!(store.prune_older_than(0).expect("prune 0") >= 1);
        assert!(store.get(&hash).is_err());
    }

    #[test]
    fn tail_lines_keeps_the_end() {
        let content = "1\n2\n3\n4";
        assert_eq!(tail_lines(content, 2), "3\n4");
        assert_eq!(tail_lines(content, 10), "1\n2\n3\n4");
    }

    fn count_files(root: &Path) -> usize {
        let mut count = 0;
        let Ok(entries) = fs::read_dir(root) else {
            return 0;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                count += count_files(&path);
            } else {
                count += 1;
            }
        }
        count
    }
}
