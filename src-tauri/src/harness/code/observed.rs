//! Política de observação de arquivos (read-before-write / CAS por hash).
//!
//! O agente só pode substituir/editar um arquivo que **leu nesta sessão** e que
//! não mudou desde a leitura. É o que torna edições de código seguras sem
//! sandbox de SO (`docs/goals/code-harness/HARNESS.md` §7.3).
//!
//! O registro é em memória (por app): depois de reiniciar, a primeira escrita
//! exige uma nova leitura — o erro `FS_NOT_OBSERVED` ensina o modelo a reler.
//! O hash é o mesmo do journal (sha256 do conteúdo).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use sha2::{Digest, Sha256};

/// sha256 hex (usado pelo journal e pela observação; `sha2 0.11` devolve `Array`).
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Versão observada de um arquivo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedVersion {
    pub hash: String,
    pub size: u64,
}

/// Estado de uma tentativa de mutação.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObservationState {
    /// Nunca lido nesta sessão.
    Missing,
    /// Lido, mas o conteúdo no disco mudou.
    Stale,
    /// Lido e inalterado — pode mutar.
    Fresh,
}

/// Identical read outputs tolerated before the loop hint is appended.
const REPEAT_READ_HINT_THRESHOLD: u32 = 3;
/// Per-app cap on tracked reads; the map resets when exceeded.
const REPEAT_READ_TRACKER_CAP: usize = 128;

#[derive(Debug, Clone)]
struct ReadRepeat {
    hash: String,
    count: u32,
}

/// Arquivos observados nesta execução do app (compartilhado no `AppState`).
///
/// A versão é **por conversa**: duas sessões no mesmo workspace não podem
/// autorizar a escrita uma da outra (B lendo/escrevendo não revalida a leitura
/// de A). O path é absoluto e o executor resolve antes de consultar.
#[derive(Default)]
pub struct ObservedFiles {
    entries: Mutex<HashMap<(String, PathBuf), ObservedVersion>>,
    reads: Mutex<HashMap<(String, PathBuf), ReadRepeat>>,
}

impl ObservedFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registra a versão atual (chamado por `read_file` e por escritas bem-sucedidas).
    pub fn record(&self, conversation_id: &str, path: &Path, bytes: &[u8]) {
        self.entries.lock().insert(
            (conversation_id.to_string(), path.to_path_buf()),
            ObservedVersion {
                hash: hash_bytes(bytes),
                size: bytes.len() as u64,
            },
        );
    }

    /// Compara o conteúdo atual com a versão observada pela conversa.
    pub fn check(&self, conversation_id: &str, path: &Path, current: &[u8]) -> ObservationState {
        let entries = self.entries.lock();
        match entries.get(&(conversation_id.to_string(), path.to_path_buf())) {
            None => ObservationState::Missing,
            Some(version) => {
                if version.size == current.len() as u64 && version.hash == hash_bytes(current) {
                    ObservationState::Fresh
                } else {
                    ObservationState::Stale
                }
            }
        }
    }

    /// Counts byte-identical `read_file` outputs per conversation/path and
    /// returns the count once the hint threshold is reached.
    pub fn note_read_output(
        &self,
        conversation_id: &str,
        path: &Path,
        content_hash: &str,
    ) -> Option<u32> {
        let mut reads = self.reads.lock();
        if reads.len() > REPEAT_READ_TRACKER_CAP {
            reads.clear();
        }
        let key = (conversation_id.to_string(), path.to_path_buf());
        match reads.get_mut(&key) {
            Some(entry) if entry.hash == content_hash => {
                entry.count = entry.count.saturating_add(1);
                (entry.count >= REPEAT_READ_HINT_THRESHOLD).then_some(entry.count)
            }
            Some(entry) => {
                entry.hash = content_hash.to_string();
                entry.count = 1;
                None
            }
            None => {
                reads.insert(
                    key,
                    ReadRepeat {
                        hash: content_hash.to_string(),
                        count: 1,
                    },
                );
                None
            }
        }
    }

    /// Esquece um arquivo (ex.: removido pelo agente).
    #[allow(dead_code)]
    pub fn forget(&self, conversation_id: &str, path: &Path) {
        self.entries
            .lock()
            .remove(&(conversation_id.to_string(), path.to_path_buf()));
    }

    #[allow(dead_code)]
    pub fn clear(&self) {
        self.entries.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_detects_changes() {
        let observed = ObservedFiles::new();
        let path = Path::new("C:/proj/a.ts");
        observed.record("conv", path, b"let a = 1;\n");
        assert_eq!(
            observed.check("conv", path, b"let a = 1;\n"),
            ObservationState::Fresh
        );
        assert_eq!(
            observed.check("conv", path, b"let a = 2;\n"),
            ObservationState::Stale
        );
        assert_eq!(
            observed.check("conv", Path::new("C:/proj/b.ts"), b"x"),
            ObservationState::Missing
        );
    }

    #[test]
    fn observations_are_scoped_per_conversation() {
        let observed = ObservedFiles::new();
        let path = Path::new("C:/proj/a.ts");
        observed.record("conv-a", path, b"let a = 1;\n");
        // Reading in A never authorizes B, and B's write never refreshes A.
        assert_eq!(
            observed.check("conv-b", path, b"let a = 1;\n"),
            ObservationState::Missing
        );
        observed.record("conv-b", path, b"let a = 2;\n");
        assert_eq!(
            observed.check("conv-a", path, b"let a = 2;\n"),
            ObservationState::Stale
        );
        assert_eq!(
            observed.check("conv-b", path, b"let a = 2;\n"),
            ObservationState::Fresh
        );
    }

    #[test]
    fn hash_is_stable_hex() {
        assert_eq!(
            hash_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_bytes(b"abc").len(), 64);
    }

    #[test]
    fn identical_reads_hint_on_the_third_output() {
        let observed = ObservedFiles::new();
        let path = Path::new("C:/proj/a.ts");
        assert_eq!(observed.note_read_output("conv", path, "hash-a"), None);
        assert_eq!(observed.note_read_output("conv", path, "hash-a"), None);
        assert_eq!(observed.note_read_output("conv", path, "hash-a"), Some(3));
    }

    #[test]
    fn changed_content_resets_the_read_counter() {
        let observed = ObservedFiles::new();
        let path = Path::new("C:/proj/a.ts");
        assert_eq!(observed.note_read_output("conv", path, "hash-a"), None);
        assert_eq!(observed.note_read_output("conv", path, "hash-a"), None);
        assert_eq!(observed.note_read_output("conv", path, "hash-b"), None);
        assert_eq!(observed.note_read_output("conv", path, "hash-a"), None);
    }

    #[test]
    fn read_counter_is_scoped_per_conversation() {
        let observed = ObservedFiles::new();
        let path = Path::new("C:/proj/a.ts");
        assert_eq!(observed.note_read_output("conv-a", path, "hash-a"), None);
        assert_eq!(observed.note_read_output("conv-a", path, "hash-a"), None);
        assert_eq!(observed.note_read_output("conv-b", path, "hash-a"), None);
    }

    #[test]
    fn forget_removes_the_entry() {
        let observed = ObservedFiles::new();
        let path = Path::new("C:/proj/a.ts");
        observed.record("conv", path, b"conteudo");
        observed.forget("conv", path);
        assert_eq!(
            observed.check("conv", path, b"conteudo"),
            ObservationState::Missing
        );
    }
}
