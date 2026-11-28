//! In-app editor write path.
//!
//! The center file tab of the Code layout is a real editor, not a preview
//! (`docs/DESIGN.md` §9). Saving goes through this module so the renderer never
//! writes bytes itself:
//!
//! - the path is confined to the workspace (`safe_path::Access::Write`, which
//!   also accepts a file that does not exist yet — Save As uses that);
//! - the *current* bytes must be UTF-8 (the editor never re-encodes a file it
//!   could not read as text);
//! - `expected_hash` is a compare-and-swap against the version the buffer was
//!   loaded from, so an agent edit (or another window) is never overwritten
//!   silently — the caller gets `FS_STALE_VERSION` and resolves the conflict;
//! - the line ending of the file is preserved (`lf`/`crlf`) because the renderer
//!   always works with LF internally;
//! - the write is atomic (temp file in the same directory, then rename) and
//!   keeps the original permissions.

use std::fs;
use std::path::Path;

use super::mutations::MutationError;
use super::safe_path::{self, Access};
use crate::harness::code::observed::hash_bytes;

/// Largest payload accepted by a single save. The reader caps editable files at
/// 512 KiB, so this is a safety net against a malformed renderer request.
pub const MAX_EDIT_BYTES: usize = 4 * 1024 * 1024;

/// Stable error codes mapped to localized messages by the command layer.
pub const EDITOR_TOO_LARGE: &str = "EDITOR_TOO_LARGE";
pub const EDITOR_UNSUPPORTED_ENCODING: &str = "EDITOR_ENCODING_UNSUPPORTED";
pub const EDITOR_BINARY: &str = "EDITOR_BINARY";
pub const FS_STALE_VERSION: &str = "FS_STALE_VERSION";
pub const FS_INVALID_EOL: &str = "FS_INVALID_EOL";

/// Line endings the editor can round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eol {
    Lf,
    Crlf,
}

impl Eol {
    /// Parses the renderer/disk representation (`lf` | `crlf`).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "lf" => Some(Self::Lf),
            "crlf" => Some(Self::Crlf),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Lf => "lf",
            Self::Crlf => "crlf",
        }
    }
}

/// Detects the dominant line ending of a file. A file with more CRLF pairs than
/// bare LF bytes is a CRLF file; anything else (including a file without line
/// breaks) is LF.
pub fn detect_eol(bytes: &[u8]) -> Eol {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            lf += 1;
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            }
        }
        index += 1;
    }
    if crlf > 0 && crlf * 2 > lf {
        Eol::Crlf
    } else {
        Eol::Lf
    }
}

/// Rewrites LF-only text into the requested line ending. CRLF/CR sequences in
/// the input are normalized first, so a mixed buffer cannot double the `\r`.
pub fn apply_eol(text: &str, eol: Eol) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    match eol {
        Eol::Lf => normalized,
        Eol::Crlf => normalized.replace('\n', "\r\n"),
    }
}

/// What was written, so the renderer can adopt the new base version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteOutcome {
    /// Workspace-relative path with `/` separators.
    pub relative: String,
    pub size: u64,
    pub hash: String,
    pub eol: Eol,
}

/// Writes `text` to `relative` inside `root`.
///
/// `expected_hash` is the sha256 of the bytes the buffer was loaded from:
/// `Some` turns the write into a compare-and-swap, `None` creates the file or
/// overwrites it on purpose (Save As, or the user explicitly keeping their
/// version after a conflict). `eol` defaults to the line ending already on disk;
/// a brand new file defaults to LF.
pub fn write_text(
    root: &Path,
    relative: &str,
    text: &str,
    expected_hash: Option<&str>,
    eol: Option<&str>,
) -> Result<WriteOutcome, MutationError> {
    let target = safe_path::resolve(root, relative, Access::Write)?;

    let requested_eol = match eol {
        Some(value) => Some(Eol::parse(value).ok_or_else(|| {
            MutationError::new(FS_INVALID_EOL, format!("invalid line ending: {value}"))
        })?),
        None => None,
    };

    if text.contains('\0') {
        return Err(MutationError::new(
            EDITOR_BINARY,
            "the editor cannot save NUL bytes",
        ));
    }
    if text.len() > MAX_EDIT_BYTES {
        return Err(MutationError::new(
            EDITOR_TOO_LARGE,
            format!("{relative} exceeds the {} byte save limit", MAX_EDIT_BYTES),
        ));
    }

    let existing = match fs::metadata(&target) {
        Ok(metadata) if metadata.is_file() => Some(metadata),
        Ok(_) => {
            return Err(MutationError::new(
                safe_path::FS_NOT_A_FILE,
                format!("{relative} is not a file"),
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };

    // Read the current bytes once: they feed the CAS check, the encoding guard
    // and the default line ending.
    let current = match &existing {
        Some(metadata) => {
            if metadata.len() > (MAX_EDIT_BYTES as u64).saturating_mul(8) {
                return Err(MutationError::new(
                    EDITOR_TOO_LARGE,
                    format!("{relative} is too large to edit"),
                ));
            }
            fs::read(&target).map_err(MutationError::from)?
        }
        None => Vec::new(),
    };

    if let Some(expected) = expected_hash {
        let current_hash = if existing.is_some() {
            Some(hash_bytes(&current))
        } else {
            None
        };
        if current_hash.as_deref() != Some(expected) {
            return Err(MutationError::new(
                FS_STALE_VERSION,
                format!("{relative} changed on disk since it was opened"),
            ));
        }
    }

    if existing.is_some() && std::str::from_utf8(&current).is_err() {
        return Err(MutationError::new(
            EDITOR_UNSUPPORTED_ENCODING,
            format!("{relative} is not UTF-8"),
        ));
    }

    let eol = match requested_eol {
        Some(eol) => eol,
        None if existing.is_some() => detect_eol(&current),
        None => Eol::Lf,
    };

    let bytes = apply_eol(text, eol).into_bytes();
    let hash = hash_bytes(&bytes);
    let permissions = existing.as_ref().map(|metadata| metadata.permissions());

    write_atomic(&target, &bytes, permissions)?;

    Ok(WriteOutcome {
        relative: safe_path::to_relative(root, &target),
        size: bytes.len() as u64,
        hash,
        eol,
    })
}

/// Same-directory temp file + rename, keeping the destination permissions.
fn write_atomic(
    path: &Path,
    bytes: &[u8],
    permissions: Option<fs::Permissions>,
) -> Result<(), MutationError> {
    let parent = path
        .parent()
        .ok_or_else(|| MutationError::new(safe_path::FS_INVALID_PATH, "path has no parent"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let temp = parent.join(format!(
        ".{}.{}-{}.tmp",
        name,
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    fs::write(&temp, bytes)?;
    if let Some(permissions) = permissions {
        // A failed permission copy must not lose the save; the content is the
        // important part and the rename below still runs.
        let _ = fs::set_permissions(&temp, permissions);
    }

    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            let _ = fs::remove_file(&temp);
            // Exotic filesystems (or a locked destination) can refuse the
            // rename; fall back to a direct write so the user keeps the edit.
            fs::write(path, bytes).map_err(|write_error| {
                MutationError::new(
                    "IO_FAILED",
                    format!("{rename_error}; direct write failed: {write_error}"),
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn creates_and_updates_files_with_the_written_hash() {
        let dir = workspace();
        let outcome = write_text(dir.path(), "notes.txt", "hello\n", None, None).expect("create");
        assert_eq!(outcome.eol, Eol::Lf);
        assert_eq!(outcome.size, 6);
        assert_eq!(
            fs::read_to_string(dir.path().join("notes.txt")).expect("read"),
            "hello\n"
        );
        assert_eq!(outcome.hash, hash_bytes(b"hello\n"));

        let updated = write_text(
            dir.path(),
            "notes.txt",
            "hello\nworld\n",
            Some(&outcome.hash),
            None,
        )
        .expect("update");
        assert_eq!(updated.size, 12);
        assert_eq!(
            fs::read_to_string(dir.path().join("notes.txt")).expect("read"),
            "hello\nworld\n"
        );
    }

    #[test]
    fn rejects_a_stale_base_version() {
        let dir = workspace();
        fs::write(dir.path().join("a.txt"), "agent\n").expect("seed");
        let error = write_text(dir.path(), "a.txt", "user\n", Some("deadbeef"), None)
            .expect_err("stale");
        assert_eq!(error.code, FS_STALE_VERSION);
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).expect("read"),
            "agent\n",
            "a refused save must not touch the file"
        );

        // Forcing (`None`) is the explicit "keep my version" path.
        write_text(dir.path(), "a.txt", "user\n", None, None).expect("force");
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).expect("read"),
            "user\n"
        );
    }

    #[test]
    fn preserves_crlf_and_utf8_bom_on_round_trip() {
        let dir = workspace();
        fs::write(dir.path().join("win.txt"), "\u{feff}linha 1\r\nlinha 2\r\n").expect("seed");
        let detected = detect_eol(&fs::read(dir.path().join("win.txt")).expect("read"));
        assert_eq!(detected, Eol::Crlf);

        write_text(dir.path(), "win.txt", "\u{feff}linha 1\r\nlinha 2\r\nlinha 3\n", None, None)
            .expect("save");
        let bytes = fs::read(dir.path().join("win.txt")).expect("read");
        assert_eq!(bytes, "\u{feff}linha 1\r\nlinha 2\r\nlinha 3\r\n".as_bytes());
    }

    #[test]
    fn refuses_binary_non_utf8_and_oversized_payloads() {
        let dir = workspace();
        fs::write(dir.path().join("latin.txt"), [0x63, 0x61, 0x66, 0xe9]).expect("seed");
        let encoding = write_text(dir.path(), "latin.txt", "cafe\n", None, None).expect_err("enc");
        assert_eq!(encoding.code, EDITOR_UNSUPPORTED_ENCODING);

        let nul = write_text(dir.path(), "novo.txt", "a\0b", None, None).expect_err("nul");
        assert_eq!(nul.code, EDITOR_BINARY);

        let big = "x".repeat(MAX_EDIT_BYTES + 1);
        let oversized = write_text(dir.path(), "grande.txt", &big, None, None).expect_err("big");
        assert_eq!(oversized.code, EDITOR_TOO_LARGE);
        assert!(!dir.path().join("novo.txt").exists());
        assert!(!dir.path().join("grande.txt").exists());
    }

    #[test]
    fn never_escapes_the_workspace_nor_writes_through_symlinks() {
        let dir = workspace();
        let root = dir.path().join("ws");
        fs::create_dir_all(&root).expect("ws");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).expect("outside");

        let escape = write_text(&root, "../outside/evil.txt", "x", None, None).expect_err("escape");
        assert_eq!(escape.code, safe_path::FS_OUTSIDE_WORKSPACE);
        assert!(!outside.join("evil.txt").exists());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link")).expect("symlink");
            let linked = write_text(&root, "link/evil.txt", "x", None, None).expect_err("symlink");
            assert_eq!(linked.code, safe_path::FS_OUTSIDE_WORKSPACE);
            assert!(!outside.join("evil.txt").exists());
        }
    }

    #[test]
    fn leaves_no_temp_files_behind() {
        let dir = workspace();
        write_text(dir.path(), "a.txt", "one\n", None, None).expect("create");
        write_text(dir.path(), "a.txt", "two\n", None, None).expect("update");

        let leftovers: Vec<String> = fs::read_dir(dir.path())
            .expect("list")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
    }

    #[test]
    fn rejects_an_unknown_line_ending_and_a_directory_target() {
        let dir = workspace();
        fs::create_dir_all(dir.path().join("src")).expect("dir");
        let directory = write_text(dir.path(), "src", "x", None, None).expect_err("dir");
        assert_eq!(directory.code, safe_path::FS_NOT_A_FILE);

        let invalid = write_text(dir.path(), "a.txt", "x", None, Some("cr")).expect_err("eol");
        assert_eq!(invalid.code, FS_INVALID_EOL);
        assert!(!dir.path().join("a.txt").exists());

        assert!(Eol::parse("cr").is_none());
        assert_eq!(Eol::parse("CRLF"), Some(Eol::Crlf));
        assert_eq!(Eol::parse(" lf "), Some(Eol::Lf));
    }

    #[test]
    fn writes_the_requested_line_ending() {
        let dir = workspace();
        write_text(dir.path(), "novo.txt", "a\nb\n", None, Some("crlf")).expect("create");
        assert_eq!(
            fs::read(dir.path().join("novo.txt")).expect("read"),
            b"a\r\nb\r\n"
        );
    }
}
