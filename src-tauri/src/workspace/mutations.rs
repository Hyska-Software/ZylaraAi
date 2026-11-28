//! User-driven workspace file mutations (Files tab actions).
//!
//! Every public entry point takes a workspace-relative path and resolves it
//! through [`super::safe_path`] before touching the disk. Nothing here is
//! callable by the model: the Tauri commands in `commands/workspace.rs` are the
//! only entry points, and they are explicit user gestures.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::safe_path::{self, Access, FsError};

/// Guards against accidental recursive copies of huge trees.
const MAX_COPY_FILES: usize = 5_000;
const MAX_COPY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_COPY_DEPTH: u32 = 32;

/// Stable error code plus a human-readable detail; commands map the code to a
/// localized message instead of leaking a raw OS error to the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationError {
    pub code: &'static str,
    pub message: String,
}

impl MutationError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<FsError> for MutationError {
    fn from(error: FsError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<std::io::Error> for MutationError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_FAILED", error.to_string())
    }
}

impl std::fmt::Display for MutationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MutationError {}

/// Parent directory of a workspace-relative path (`"."` for root-level names).
fn parent_relative(path: &str) -> &str {
    path.rsplit_once('/').map(|(parent, _)| parent).unwrap_or(".")
}

/// Refuses to mutate the workspace root itself.
fn reject_root(root: &Path, target: &Path) -> Result<(), MutationError> {
    let root = dunce::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let target = dunce::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    if root == target {
        return Err(MutationError::new("ENTRY_ROOT", "the workspace root cannot be changed"));
    }
    Ok(())
}

fn resolve_new(root: &Path, path: &str) -> Result<PathBuf, MutationError> {
    if path.trim().is_empty() || path == "." {
        return Err(MutationError::new("FS_EMPTY_PATH", "a file name is required"));
    }
    if path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(MutationError::new("FS_INVALID_PATH", "invalid file name"));
    }
    safe_path::resolve(root, parent_relative(path), Access::ReadDir)?;
    // Probe with `Mutate` first so an existing directory reports ENTRY_EXISTS
    // instead of the `Write` mode's FS_NOT_A_FILE.
    match safe_path::resolve(root, path, Access::Mutate) {
        Ok(_) => return Err(MutationError::new("ENTRY_EXISTS", "the path already exists")),
        Err(error) if error.code == safe_path::FS_NOT_FOUND => {}
        Err(error) => return Err(error.into()),
    }
    let target = safe_path::resolve(root, path, Access::Write)?;
    Ok(target)
}

/// Creates an empty file at `path`. Never overwrites an existing entry.
pub fn create_file(root: &Path, path: &str) -> Result<PathBuf, MutationError> {
    let target = resolve_new(root, path)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&target)?;
    file.flush()?;
    Ok(target)
}

/// Creates a directory at `path` (the parent must already exist).
pub fn create_dir(root: &Path, path: &str) -> Result<PathBuf, MutationError> {
    let target = resolve_new(root, path)?;
    fs::create_dir(&target)?;
    Ok(target)
}

/// Moves a file or directory to a new path inside the same workspace.
pub fn rename(root: &Path, from: &str, to: &str) -> Result<PathBuf, MutationError> {
    let source = safe_path::resolve(root, from, Access::Mutate)?;
    reject_root(root, &source)?;
    let destination = resolve_new(root, to)?;
    if source.is_dir() && safe_path::is_within(&source, &destination) {
        return Err(MutationError::new("FS_INVALID_PATH", "a directory cannot be moved into itself"));
    }
    fs::rename(&source, &destination)?;
    Ok(destination)
}

/// Builds `name (copy).ext`, then `name (copy 2).ext`, ... without overwriting.
fn copy_name(original: &str, index: usize) -> String {
    let suffix = if index == 1 {
        " (copy)".to_string()
    } else {
        format!(" (copy {index})")
    };
    match original.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() =>
            format!("{stem}{suffix}.{extension}"),
        _ => format!("{original}{suffix}"),
    }
}

fn unique_copy_path(root: &Path, relative: &str) -> Result<PathBuf, MutationError> {
    let parent = parent_relative(relative);
    let name = relative.rsplit('/').next().unwrap_or(relative);
    for index in 1..=1_000 {
        let candidate_relative = if parent == "." {
            copy_name(name, index)
        } else {
            format!("{parent}/{}", copy_name(name, index))
        };
        match resolve_new(root, &candidate_relative) {
            Ok(path) => return Ok(path),
            Err(error) if error.code == "ENTRY_EXISTS" => continue,
            Err(error) => return Err(error),
        }
    }
    Err(MutationError::new("ENTRY_EXISTS", "no free copy name was found"))
}

/// Returns the workspace-relative path of the copy, preserving the source name.
pub fn duplicate(root: &Path, path: &str) -> Result<PathBuf, MutationError> {
    let source = safe_path::resolve(root, path, Access::Mutate)?;
    reject_root(root, &source)?;
    let destination = unique_copy_path(root, path)?;
    if source.is_dir() {
        copy_tree(&source, &destination, 0, &mut 0, &mut 0)?;
    } else {
        copy_checked(&source, &destination, &mut 0)?;
    }
    Ok(destination)
}

fn copy_checked(source: &Path, destination: &Path, bytes: &mut u64) -> Result<(), MutationError> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(MutationError::new("SYMLINK", "symbolic links are not copied"));
    }
    *bytes = bytes.saturating_add(metadata.len());
    if *bytes > MAX_COPY_BYTES {
        return Err(MutationError::new("COPY_LIMIT", "the copy exceeds the size limit"));
    }
    fs::copy(source, destination)?;
    Ok(())
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    depth: u32,
    files: &mut usize,
    bytes: &mut u64,
) -> Result<(), MutationError> {
    if depth > MAX_COPY_DEPTH {
        return Err(MutationError::new("COPY_LIMIT", "the copy exceeds the depth limit"));
    }
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        *files = files.saturating_add(1);
        if *files > MAX_COPY_FILES {
            return Err(MutationError::new("COPY_LIMIT", "the copy exceeds the file limit"));
        }
        let name = entry.file_name();
        let child_source = entry.path();
        let child_destination = destination.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&child_source, &child_destination, depth + 1, files, bytes)?;
        } else {
            copy_checked(&child_source, &child_destination, bytes)?;
        }
    }
    Ok(())
}

/// Deletes a file or a directory tree. The workspace root is never a target.
pub fn delete(root: &Path, path: &str) -> Result<(), MutationError> {
    let target = safe_path::resolve(root, path, Access::Mutate)?;
    reject_root(root, &target)?;
    if target.is_dir() {
        fs::remove_dir_all(&target)?;
    } else {
        fs::remove_file(&target)?;
    }
    Ok(())
}

/// Resolves an entry for a non-mutating action (reveal/download).
pub fn resolve_existing(root: &Path, path: &str) -> Result<PathBuf, MutationError> {
    Ok(safe_path::resolve(root, path, Access::Mutate)?)
}

/// Copies a workspace file into a destination chosen by the native save dialog.
pub fn save_copy(source: &Path, destination: &Path) -> Result<(), MutationError> {
    let mut input = File::open(source)?;
    if input.metadata()?.len() > MAX_COPY_BYTES {
        return Err(MutationError::new("COPY_LIMIT", "the file exceeds the size limit"));
    }
    let mut output = File::create(destination)?;
    std::io::copy(&mut input, &mut output)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("ws");
        fs::create_dir_all(&root).expect("root");
        (temp, root)
    }

    #[test]
    fn create_file_and_dir_refuse_overwrite_and_escape() {
        let (temp, root) = workspace();
        let file = create_file(&root, "notes.txt").expect("create file");
        assert_eq!(file, root.join("notes.txt"));
        assert_eq!(fs::read_to_string(&file).expect("read"), "");
        assert_eq!(create_file(&root, "notes.txt").expect_err("exists").code, "ENTRY_EXISTS");
        let dir = create_dir(&root, "src").expect("create dir");
        assert!(dir.is_dir());
        assert_eq!(create_dir(&root, "src").expect_err("exists").code, "ENTRY_EXISTS");
        assert_eq!(
            create_file(&root, "../outside.txt").expect_err("escape").code,
            "FS_INVALID_PATH"
        );
        assert!(!temp.path().join("outside.txt").exists());
    }

    #[test]
    fn rename_moves_files_and_directories_without_overwriting() {
        let (_temp, root) = workspace();
        create_file(&root, "a.txt").expect("create");
        let renamed = rename(&root, "a.txt", "b.txt").expect("rename file");
        assert_eq!(renamed, root.join("b.txt"));
        assert!(!root.join("a.txt").exists());

        create_dir(&root, "dir").expect("dir");
        create_file(&root, "dir/child.txt").expect("child");
        rename(&root, "dir", "other").expect("rename dir");
        assert!(root.join("other/child.txt").is_file());
        assert_eq!(rename(&root, "other", "b.txt").expect_err("exists").code, "ENTRY_EXISTS");
        assert_eq!(rename(&root, ".", "x").expect_err("root").code, "ENTRY_ROOT");
        assert_eq!(
            rename(&root, "other", "other/nested").expect_err("self").code,
            "FS_INVALID_PATH"
        );
    }

    #[test]
    fn duplicate_uses_unique_names_and_copies_directories() {
        let (_temp, root) = workspace();
        create_dir(&root, "src").expect("dir");
        create_file(&root, "src/app.ts").expect("file");
        fs::write(root.join("src/app.ts"), "code").expect("content");

        let first = duplicate(&root, "src/app.ts").expect("copy file");
        assert_eq!(first, root.join("src/app (copy).ts"));
        assert_eq!(fs::read_to_string(&first).expect("read"), "code");
        let second = duplicate(&root, "src/app.ts").expect("second copy");
        assert_eq!(second, root.join("src/app (copy 2).ts"));

        let dir_copy = duplicate(&root, "src").expect("copy dir");
        assert_eq!(dir_copy, root.join("src (copy)"));
        assert!(dir_copy.join("app.ts").is_file());
    }

    #[test]
    fn delete_removes_entries_but_never_the_root() {
        let (_temp, root) = workspace();
        create_dir(&root, "dir").expect("dir");
        create_file(&root, "dir/a.txt").expect("file");
        delete(&root, "dir").expect("delete dir");
        assert!(!root.join("dir").exists());
        assert_eq!(delete(&root, ".").expect_err("root").code, "ENTRY_ROOT");
    }

    #[test]
    fn recursive_copy_rejects_symlinks() {
        let (_temp, root) = workspace();
        create_dir(&root, "src").expect("dir");
        let source = root.join("src");
        let outside = root.join("outside.txt");
        fs::write(&outside, "x").expect("outside");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, source.join("link.txt")).expect("symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&outside, source.join("link.txt")).is_err() {
            // Creating symlinks on Windows requires developer mode or elevation.
            return;
        }
        assert_eq!(duplicate(&root, "src").expect_err("symlink").code, "SYMLINK");
    }
}
