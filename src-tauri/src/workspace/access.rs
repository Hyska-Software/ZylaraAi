//! Coordenação de mutações de arquivos entre sessões paralelas.
//!
//! Conversas diferentes podem rodar no mesmo diretório ao mesmo tempo
//! (`docs/ARCHITECTURE.md` §4). O antigo mutex por turno/workspace serializava a
//! conversa inteira; aqui a serialização é **por operação**: uma mutação gerida
//! segura o lock do root apenas durante ler → validar → gravar → journal. O lock
//! nunca é mantido enquanto o turno espera o modelo ou uma aprovação humana.
//!
//! O lock é identificado pela raiz de escrita canonicalizada, não pelo id da
//! conversa/turno: dois registros de workspace apontando para a mesma pasta (ou
//! um alias com `..`/separador diferente) coordenam entre si. Raízes aninhadas
//! (projeto e subpasta) continuam sendo domínios distintos — a detecção de
//! conflito por hash cobre esse caso.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};

use parking_lot::Mutex;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

/// Chave de coordenação de uma raiz de escrita (canônica, sem separador misto).
///
/// `dunce::canonicalize` remove o prefixo `\\?\` no Windows sem perder a
/// resolução de symlink, então o mesmo caminho escrito de duas formas gera a
/// mesma chave. No Windows a comparação é case-insensitive.
pub fn mutation_key(root: &Path) -> String {
    let canonical: PathBuf = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let text = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn locks() -> &'static Mutex<HashMap<String, Weak<AsyncMutex<()>>>> {
    static LOCKS: LazyLock<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>> =
        LazyLock::new(Default::default);
    &LOCKS
}

/// Lock de mutação de um root. Duas chamadas para o mesmo caminho devolvem o
/// mesmo `Arc` enquanto algum guard estiver vivo.
pub fn mutation_lock(root: &Path) -> Arc<AsyncMutex<()>> {
    let key = mutation_key(root);
    let mut locks = locks().lock();
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

/// Espera acesso exclusivo às mutações de um root, abortando quando o turno é
/// cancelado enquanto espera outra sessão.
pub async fn acquire_mutation(
    root: &Path,
    cancel: &CancellationToken,
) -> anyhow::Result<OwnedMutexGuard<()>> {
    if cancel.is_cancelled() {
        return Err(anyhow::anyhow!(crate::i18n::t("tools.exec.fs.cancelled")));
    }
    let lock = mutation_lock(root);
    if let Ok(guard) = lock.clone().try_lock_owned() {
        return Ok(guard);
    }
    let acquire = lock.lock_owned();
    tokio::pin!(acquire);
    tokio::select! {
        guard = &mut acquire => Ok(guard),
        _ = cancel.cancelled() => Err(anyhow::anyhow!(
            crate::i18n::t("tools.exec.fs.cancelled")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        std::fs::create_dir_all(&root).expect("create root");
        (temp, root)
    }

    #[test]
    fn key_is_stable_across_aliases() {
        let (_temp, root) = temp_root();
        std::fs::create_dir_all(root.join("sub")).expect("sub");
        let alias = root.join("sub").join("..");
        assert_eq!(mutation_key(&root), mutation_key(&alias));
        #[cfg(windows)]
        {
            let upper = PathBuf::from(mutation_key(&root).replace('/', "\\").to_uppercase());
            assert_eq!(mutation_key(&root), mutation_key(&upper));
        }
    }

    #[tokio::test]
    async fn mutations_of_one_root_are_serialized() {
        let (_temp, root) = temp_root();
        let first = acquire_mutation(&root, &CancellationToken::new())
            .await
            .expect("first");
        assert!(mutation_lock(&root).try_lock_owned().is_err());

        let waiter = {
            let root = root.clone();
            tokio::spawn(async move {
                acquire_mutation(&root, &CancellationToken::new())
                    .await
                    .map(|_guard| ())
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert!(!waiter.is_finished());
        drop(first);
        waiter.await.expect("join").expect("second");
    }

    #[tokio::test]
    async fn different_roots_do_not_block_each_other() {
        let (_temp_a, root_a) = temp_root();
        let (_temp_b, root_b) = temp_root();
        let _held = acquire_mutation(&root_a, &CancellationToken::new())
            .await
            .expect("a");
        let other = acquire_mutation(&root_b, &CancellationToken::new()).await;
        assert!(other.is_ok());
    }

    #[tokio::test]
    async fn waiting_for_a_root_can_be_cancelled() {
        let (_temp, root) = temp_root();
        let held = acquire_mutation(&root, &CancellationToken::new())
            .await
            .expect("held");
        let cancel = CancellationToken::new();
        let waiter = {
            let root = root.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                acquire_mutation(&root, &cancel)
                    .await
                    .map(|_guard| ())
                    .is_err()
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        cancel.cancel();
        assert!(waiter.await.expect("join"));
        drop(held);
    }
}
