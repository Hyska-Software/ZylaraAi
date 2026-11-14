//! Runtime nativo do workspace do harness de código.
//!
//! - `safe_path`: confinamento de paths ao workspace (anti `..`, symlink, UNC, device).
//! - `exec`: runner de processos com timeout, cancelamento, env saneado e kill de árvore.
//! - `project`: detecção do perfil do projeto (comandos de test/lint/build).
//! - `git`: operações de git via CLI do usuário (status/diff/log/stage/commit/branches).
//! - `journal`: object store por hash, captura de arquivos por turno e diff unificado.
//! - `docker`: saúde do daemon Docker (classificação do erro de transporte e
//!   auto-start limitado do Docker Desktop).
//!
//! Contrato e limites: `docs/goals/code-harness/HARNESS.md` §7–§9.

#![allow(dead_code)]

pub mod docker;
pub mod exec;
pub mod git;
pub mod journal;
pub mod project;
pub mod safe_path;
pub mod watch;

pub use exec::{ExecError, ExecOutput, ExecRequest, StreamKind};
pub use git::{GitBranch, GitCommit, GitFile, GitStatus};
pub use journal::{line_stats, unified_diff, FileCapture, ObjectStore};
pub use project::{ProjectCheck, ProjectProfile};
pub use safe_path::{is_within, resolve, to_relative, Access, FsError};
