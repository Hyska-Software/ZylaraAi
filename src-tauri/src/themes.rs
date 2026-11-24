//! Installable declarative themes.
//!
//! A theme package is a ZIP with a `theme.json` manifest (at the archive root
//! or inside a single wrapper folder) and the assets it references. This module
//! validates the manifest against a fixed token allowlist, extracts only the
//! referenced assets and exposes the resulting themes under
//! `<app-data>/themes/<id>/`. There is no arbitrary CSS or JavaScript.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::domain::{ThemeFontPaths, ThemeInfo, ThemeInstallResult, ThemeVariant};

/// Built-in theme id; never installable or removable.
pub const BUILTIN_THEME_ID: &str = "zylara";

/// Additional bundled themes embedded in the binary. Their ids are reserved and
/// they are not written to `<app-data>/themes`.
const BUNDLED_THEME_IDS: &[&str] = &["aurora", "ember", "grove", "nebula", "nocturne"];
const BUNDLED_MANIFESTS: &[&str] = &[
    include_str!("../themes/aurora.json"),
    include_str!("../themes/ember.json"),
    include_str!("../themes/grove.json"),
    include_str!("../themes/nebula.json"),
    include_str!("../themes/nocturne.json"),
];

const THEMES_DIR: &str = "themes";
const THEME_MANIFEST: &str = "theme.json";

/// Theme ids under this prefix belong to enabled plugin contributions
/// (`pluginThemeId` in the renderer); host packages must never claim them.
const PLUGIN_THEME_ID_PREFIX: &str = "plugin-";

const MAX_ARCHIVE_BYTES: u64 = 24 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 24 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 256;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_WALLPAPER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_FONT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WALLPAPER_SIDE: u32 = 8192;
const MAX_TOKENS: usize = 64;
const MAX_TOKEN_VALUE_CHARS: usize = 64;
const MAX_ASSET_PATH_CHARS: usize = 160;
const MAX_NAME_CHARS: usize = 80;
const MAX_AUTHOR_CHARS: usize = 80;
const MAX_DESCRIPTION_CHARS: usize = 300;
const MAX_VERSION_CHARS: usize = 32;

const THEME_TOKENS_JSON: &str = include_str!("../../data/theme-tokens.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeTokenCatalog {
    required: Vec<String>,
    optional_color: Vec<String>,
    optional_length: Vec<String>,
}

static THEME_TOKENS: LazyLock<ThemeTokenCatalog> = LazyLock::new(|| {
    serde_json::from_str(THEME_TOKENS_JSON).expect("data/theme-tokens.json must be valid JSON")
});

fn required_tokens() -> &'static [String] {
    &THEME_TOKENS.required
}

fn optional_color_tokens() -> &'static [String] {
    &THEME_TOKENS.optional_color
}

fn optional_length_tokens() -> &'static [String] {
    &THEME_TOKENS.optional_length
}

fn is_color_token(token: &str) -> bool {
    required_tokens().iter().any(|value| value == token)
        || optional_color_tokens().iter().any(|value| value == token)
}

/// Whether a bare token name (`accent`, `radius-md`) is accepted by the theme
/// and plugin-preset allowlists.
pub fn is_known_theme_token(token: &str) -> bool {
    is_color_token(token) || optional_length_tokens().iter().any(|value| value == token)
}

pub fn is_theme_length_token(token: &str) -> bool {
    optional_length_tokens().iter().any(|value| value == token)
}

/// Validates a partial palette contributed by a plugin theme or preset.
///
/// Unlike installed host themes, plugin themes do not need to provide every
/// required token; missing values fall back to the host CSS defaults. Token
/// names/values still use the exact host allowlist.
pub fn validate_contributed_tokens(
    variant: &str,
    tokens: &BTreeMap<String, String>,
    label: &str,
) -> Result<(), String> {
    if tokens.len() > MAX_TOKENS {
        return Err(format!(
            "PLUGIN_THEME_TOKEN_LIMIT: {label} `{variant}` has more than {MAX_TOKENS} tokens"
        ));
    }
    for (key, raw) in tokens {
        let token = key.strip_prefix("--").unwrap_or(key);
        let Some(kind) = token_kind(token) else {
            return Err(format!(
                "PLUGIN_THEME_TOKEN_UNKNOWN: {label} `{variant}` has unknown token `{key}`"
            ));
        };
        let value = raw.trim();
        let valid = !value.is_empty()
            && value.chars().count() <= MAX_TOKEN_VALUE_CHARS
            && match kind {
                TokenKind::Color => is_color(value),
                TokenKind::Length => is_length(value),
            };
        if !valid {
            return Err(format!(
                "PLUGIN_THEME_TOKEN_INVALID: {label} `{variant}` has invalid value for `{key}`"
            ));
        }
    }
    Ok(())
}

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif"];
const FONT_EXTENSIONS: &[&str] = &["woff2", "woff", "ttf", "otf"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenKind {
    Color,
    Length,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    Image,
    Font,
}

fn default_theme_version() -> String {
    "1.0.0".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThemeManifest {
    schema_version: u32,
    id: String,
    name: String,
    #[serde(default = "default_theme_version")]
    version: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    description: String,
    tokens: ThemeTokenSets,
    #[serde(default)]
    fonts: ThemeFontsManifest,
    #[serde(default)]
    wallpaper: ThemeWallpaperManifest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThemeTokenSets {
    light: BTreeMap<String, String>,
    dark: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThemeFontsManifest {
    #[serde(default)]
    sans: Option<String>,
    #[serde(default)]
    mono: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThemeWallpaperManifest {
    #[serde(default)]
    light: Option<String>,
    #[serde(default)]
    dark: Option<String>,
}

/// Syntax-only validation for a theme id (`zylara` is syntactically valid).
pub fn is_valid_theme_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 {
        return false;
    }
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-'))
}

/// Whether `id` belongs to the built-in Zylara theme or a bundled theme.
pub fn is_builtin_theme_id(id: &str) -> bool {
    id == BUILTIN_THEME_ID || BUNDLED_THEME_IDS.contains(&id)
}

/// Resolves the themes directory below the app-data directory.
pub fn themes_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(THEMES_DIR)
}

fn error_key(key: &str) -> String {
    crate::i18n::t(key)
}

fn error_args(key: &str, args: &[(&str, &str)]) -> String {
    crate::i18n::t_args(key, args)
}

fn token_kind(token: &str) -> Option<TokenKind> {
    if is_color_token(token) {
        Some(TokenKind::Color)
    } else if optional_length_tokens().iter().any(|value| value == token) {
        Some(TokenKind::Length)
    } else {
        None
    }
}

fn extension(path: &str) -> String {
    path.rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_image_asset(path: &str) -> bool {
    IMAGE_EXTENSIONS.contains(&extension(path).as_str())
}

fn is_font_asset(path: &str) -> bool {
    FONT_EXTENSIONS.contains(&extension(path).as_str())
}

/// Validates and normalizes a relative asset path. Rejects traversal, absolute
/// paths, Windows separators/drive prefixes, control characters and empty `.`/
/// `..` segments.
fn safe_relative(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_ASSET_PATH_CHARS
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.chars().any(char::is_control)
    {
        return Err(error_args(
            "themes.errors.unsafeEntry",
            &[("path", value)],
        ));
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(error_args(
                "themes.errors.unsafeEntry",
                &[("path", value)],
            ));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

fn is_color(value: &str) -> bool {
    let value = value.trim();
    if value.eq_ignore_ascii_case("transparent") {
        return true;
    }
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|ch| ch.is_ascii_hexdigit());
    }
    let Some(open) = value.find('(') else {
        return false;
    };
    if !value.ends_with(')') {
        return false;
    }
    let name = &value[..open];
    if !matches!(
        name,
        "rgb" | "rgba" | "hsl" | "hsla" | "oklch" | "oklab" | "lab" | "lch" | "color"
    ) {
        return false;
    }
    let inner = &value[open + 1..value.len() - 1];
    !inner.is_empty()
        && inner.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '.' | ',' | '%' | '/' | '+' | '-' | ' ')
        })
}

fn is_length(value: &str) -> bool {
    let value = value.trim();
    if value == "0" {
        return true;
    }
    let Some(unit) = ["rem", "px", "em"]
        .into_iter()
        .find(|unit| value.ends_with(unit))
    else {
        return false;
    };
    let number = &value[..value.len() - unit.len()];
    !number.is_empty()
        && !number.starts_with('.')
        && !number.ends_with('.')
        && number.matches('.').count() <= 1
        && number.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
}

fn validate_tokens(variant: &str, tokens: &BTreeMap<String, String>) -> Result<(), String> {
    if tokens.len() > MAX_TOKENS {
        return Err(error_key("themes.errors.tooManyTokens"));
    }
    for token in required_tokens() {
        if !tokens.contains_key(token) {
            return Err(error_args(
                "themes.errors.missingToken",
                &[("variant", variant), ("token", token.as_str())],
            ));
        }
    }
    for (token, raw) in tokens {
        let Some(kind) = token_kind(token) else {
            return Err(error_args(
                "themes.errors.unknownToken",
                &[("token", token)],
            ));
        };
        let value = raw.trim();
        let valid = !value.is_empty()
            && value.chars().count() <= MAX_TOKEN_VALUE_CHARS
            && match kind {
                TokenKind::Color => is_color(value),
                TokenKind::Length => is_length(value),
            };
        if !valid {
            return Err(error_args(
                "themes.errors.invalidTokenValue",
                &[("token", token), ("variant", variant)],
            ));
        }
    }
    Ok(())
}

fn trim_tokens(tokens: &mut BTreeMap<String, String>) {
    for value in tokens.values_mut() {
        *value = value.trim().to_string();
    }
}

fn normalize_asset(
    value: &str,
    kind: AssetKind,
) -> Result<String, String> {
    let path = safe_relative(value)?;
    let supported = match kind {
        AssetKind::Image => is_image_asset(&path),
        AssetKind::Font => is_font_asset(&path),
    };
    if !supported {
        return Err(error_args(
            "themes.errors.unsupportedAsset",
            &[("asset", value)],
        ));
    }
    Ok(path)
}

fn validate_manifest(manifest: &mut ThemeManifest) -> Result<(), String> {
    manifest.id = manifest.id.trim().to_string();
    manifest.name = manifest.name.trim().to_string();
    manifest.version = manifest.version.trim().to_string();
    if manifest.version.is_empty() {
        manifest.version = default_theme_version();
    }
    manifest.author = manifest.author.trim().to_string();
    manifest.description = manifest.description.trim().to_string();

    if manifest.schema_version != 1 {
        return Err(error_args(
            "themes.errors.unsupportedSchema",
            &[("version", &manifest.schema_version.to_string())],
        ));
    }
    if !is_valid_theme_id(&manifest.id) {
        return Err(error_args(
            "themes.errors.invalidId",
            &[("id", &manifest.id)],
        ));
    }
    if manifest.name.is_empty() || manifest.name.chars().count() > MAX_NAME_CHARS {
        return Err(error_key("themes.errors.invalidName"));
    }
    if manifest.version.chars().count() > MAX_VERSION_CHARS
        || manifest.author.chars().count() > MAX_AUTHOR_CHARS
        || manifest.description.chars().count() > MAX_DESCRIPTION_CHARS
    {
        return Err(error_key("themes.errors.invalidMetadata"));
    }

    trim_tokens(&mut manifest.tokens.light);
    trim_tokens(&mut manifest.tokens.dark);
    validate_tokens("light", &manifest.tokens.light)?;
    validate_tokens("dark", &manifest.tokens.dark)?;

    if let Some(path) = manifest.fonts.sans.as_mut() {
        *path = normalize_asset(path, AssetKind::Font)?;
    }
    if let Some(path) = manifest.fonts.mono.as_mut() {
        *path = normalize_asset(path, AssetKind::Font)?;
    }
    if let Some(path) = manifest.wallpaper.light.as_mut() {
        *path = normalize_asset(path, AssetKind::Image)?;
    }
    if let Some(path) = manifest.wallpaper.dark.as_mut() {
        *path = normalize_asset(path, AssetKind::Image)?;
    }
    Ok(())
}

fn parse_manifest(raw: &str) -> Result<ThemeManifest, String> {
    let mut manifest: ThemeManifest = serde_json::from_str(raw).map_err(|error| {
        error_args(
            "themes.errors.manifestInvalid",
            &[("error", &error.to_string())],
        )
    })?;
    validate_manifest(&mut manifest)?;
    Ok(manifest)
}

fn info_from_manifest(manifest: &ThemeManifest) -> ThemeInfo {
    ThemeInfo {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        author: manifest.author.clone(),
        description: manifest.description.clone(),
        built_in: false,
        light: ThemeVariant {
            tokens: manifest.tokens.light.clone(),
            wallpaper: manifest.wallpaper.light.clone(),
        },
        dark: ThemeVariant {
            tokens: manifest.tokens.dark.clone(),
            wallpaper: manifest.wallpaper.dark.clone(),
        },
        fonts: ThemeFontPaths {
            sans: manifest.fonts.sans.clone(),
            mono: manifest.fonts.mono.clone(),
        },
    }
}

fn builtin_theme() -> ThemeInfo {
    ThemeInfo {
        id: BUILTIN_THEME_ID.to_string(),
        name: "Zylara".to_string(),
        version: String::new(),
        author: String::new(),
        description: String::new(),
        built_in: true,
        light: ThemeVariant {
            tokens: BTreeMap::new(),
            wallpaper: None,
        },
        dark: ThemeVariant {
            tokens: BTreeMap::new(),
            wallpaper: None,
        },
        fonts: ThemeFontPaths::default(),
    }
}

/// Parses the manifests embedded with `include_str!` and marks them built-in.
fn bundled_themes() -> Vec<ThemeInfo> {
    BUNDLED_MANIFESTS
        .iter()
        .filter_map(|raw| parse_manifest(raw).ok())
        .map(|manifest| {
            let mut info = info_from_manifest(&manifest);
            info.built_in = true;
            info
        })
        .collect()
}

/// Lists the built-in theme followed by every valid installed theme.
pub fn list_themes(data_dir: &Path) -> Vec<ThemeInfo> {
    let mut themes = vec![builtin_theme()];
    themes.extend(bundled_themes());
    let Ok(entries) = fs::read_dir(themes_dir(data_dir)) else {
        return themes;
    };
    let mut installed = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let directory_name = entry.file_name();
        let Some(directory_name) = directory_name.to_str() else {
            continue;
        };
        if directory_name.starts_with('.') || is_builtin_theme_id(directory_name) {
            continue;
        }
        if directory_name.starts_with(PLUGIN_THEME_ID_PREFIX) {
            continue;
        }
        let manifest_path = entry.path().join(THEME_MANIFEST);
        let Ok(bytes) = fs::read(&manifest_path) else {
            continue;
        };
        if bytes.len() as u64 > MAX_MANIFEST_BYTES {
            continue;
        }
        let Ok(raw) = String::from_utf8(bytes) else {
            continue;
        };
        let Ok(manifest) = parse_manifest(&raw) else {
            continue;
        };
        if manifest.id != directory_name {
            continue;
        }
        installed.push(info_from_manifest(&manifest));
    }
    installed.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    themes.extend(installed);
    themes
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else if path.exists() {
        fs::remove_file(path)
    } else {
        Ok(())
    }
}

/// Removes an installed theme. Missing directories are idempotent.
pub fn uninstall_theme(data_dir: &Path, id: &str) -> Result<Vec<ThemeInfo>, String> {
    if is_builtin_theme_id(id) || id.starts_with(PLUGIN_THEME_ID_PREFIX) {
        return Err(error_key("themes.errors.reservedId"));
    }
    if !is_valid_theme_id(id) {
        return Err(error_key("themes.errors.invalidThemeId"));
    }
    let target = themes_dir(data_dir).join(id);
    remove_path(&target).map_err(|error| {
        error_args(
            "themes.errors.uninstallFailed",
            &[("error", &error.to_string())],
        )
    })?;
    Ok(list_themes(data_dir))
}

fn mime_for_asset(asset: &str) -> Option<(&'static str, u64)> {
    match extension(asset).as_str() {
        "png" => Some(("image/png", MAX_WALLPAPER_BYTES)),
        "jpg" | "jpeg" => Some(("image/jpeg", MAX_WALLPAPER_BYTES)),
        "webp" => Some(("image/webp", MAX_WALLPAPER_BYTES)),
        "gif" => Some(("image/gif", MAX_WALLPAPER_BYTES)),
        "woff2" => Some(("font/woff2", MAX_FONT_BYTES)),
        "woff" => Some(("font/woff", MAX_FONT_BYTES)),
        "ttf" => Some(("font/ttf", MAX_FONT_BYTES)),
        "otf" => Some(("font/otf", MAX_FONT_BYTES)),
        _ => None,
    }
}

/// Reads one installed asset and returns a bounded `data:` URL.
pub fn theme_asset(data_dir: &Path, id: &str, asset: &str) -> Result<String, String> {
    if is_builtin_theme_id(id) {
        return Err(error_key("themes.errors.themeNotFound"));
    }
    if !is_valid_theme_id(id) {
        return Err(error_key("themes.errors.invalidThemeId"));
    }
    let asset = safe_relative(asset)?;
    let Some((mime, limit)) = mime_for_asset(&asset) else {
        return Err(error_args(
            "themes.errors.unsupportedAsset",
            &[("asset", &asset)],
        ));
    };
    let root = themes_dir(data_dir).join(id);
    if !root.is_dir() {
        return Err(error_key("themes.errors.themeNotFound"));
    }
    let path = root.join(&asset);
    if !path.is_file() {
        return Err(error_args(
            "themes.errors.assetMissing",
            &[("asset", &asset)],
        ));
    }
    let canonical_root = fs::canonicalize(&root).map_err(|error| {
        error_args(
            "themes.errors.assetReadFailed",
            &[("error", &error.to_string())],
        )
    })?;
    let canonical_path = fs::canonicalize(&path).map_err(|error| {
        error_args(
            "themes.errors.assetReadFailed",
            &[("error", &error.to_string())],
        )
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(error_args(
            "themes.errors.unsafeEntry",
            &[("path", &asset)],
        ));
    }
    let metadata = fs::metadata(&canonical_path).map_err(|error| {
        error_args(
            "themes.errors.assetReadFailed",
            &[("error", &error.to_string())],
        )
    })?;
    if metadata.len() > limit {
        return Err(error_args(
            "themes.errors.assetTooLarge",
            &[("asset", &asset)],
        ));
    }
    let bytes = fs::read(&canonical_path).map_err(|error| {
        error_args(
            "themes.errors.assetReadFailed",
            &[("error", &error.to_string())],
        )
    })?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn read_capped(
    archive: &mut zip::ZipArchive<File>,
    index: usize,
    limit: u64,
) -> Result<Option<Vec<u8>>, String> {
    let entry = archive.by_index(index).map_err(|error| {
        error_args(
            "themes.errors.archiveInvalid",
            &[("error", &error.to_string())],
        )
    })?;
    if entry.size() > limit {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    entry
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            error_args(
                "themes.errors.archiveInvalid",
                &[("error", &error.to_string())],
            )
        })?;
    if bytes.len() as u64 > limit {
        return Ok(None);
    }
    Ok(Some(bytes))
}

fn validate_image(bytes: &[u8], asset: &str) -> Result<(), String> {
    let expected = match extension(asset).as_str() {
        "png" => image::ImageFormat::Png,
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "webp" => image::ImageFormat::WebP,
        "gif" => image::ImageFormat::Gif,
        _ => {
            return Err(error_args(
                "themes.errors.unsupportedAsset",
                &[("asset", asset)],
            ))
        }
    };
    let invalid = || {
        error_args(
            "themes.errors.invalidImage",
            &[("asset", asset)],
        )
    };
    if image::guess_format(bytes).map_err(|_| invalid())? != expected {
        return Err(invalid());
    }
    let (width, height) = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| invalid())?
        .into_dimensions()
        .map_err(|_| invalid())?;
    if width == 0 || height == 0 || width > MAX_WALLPAPER_SIDE || height > MAX_WALLPAPER_SIDE {
        return Err(invalid());
    }
    Ok(())
}

fn validate_font(bytes: &[u8], asset: &str) -> Result<(), String> {
    let valid = match extension(asset).as_str() {
        "woff2" => bytes.starts_with(b"wOF2"),
        "woff" => bytes.starts_with(b"wOFF"),
        "otf" => bytes.starts_with(b"OTTO"),
        "ttf" => {
            bytes.starts_with(&[0, 1, 0, 0]) || bytes.starts_with(b"true") || bytes.starts_with(b"ttcf")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(error_args(
            "themes.errors.invalidFont",
            &[("asset", asset)],
        ))
    }
}

fn validate_asset_bytes(asset: &str, kind: AssetKind, bytes: &[u8]) -> Result<(), String> {
    match kind {
        AssetKind::Image => validate_image(bytes, asset),
        AssetKind::Font => validate_font(bytes, asset),
    }
}

/// Installs (or atomically replaces) a theme from a ZIP package.
pub fn install_theme(data_dir: &Path, archive_path: &Path) -> Result<ThemeInstallResult, String> {
    let metadata = fs::metadata(archive_path).map_err(|error| {
        error_args(
            "themes.errors.archiveInvalid",
            &[("error", &error.to_string())],
        )
    })?;
    if !metadata.is_file() {
        return Err(error_args(
            "themes.errors.archiveInvalid",
            &[("error", "not a file")],
        ));
    }
    if metadata.len() > MAX_ARCHIVE_BYTES {
        return Err(error_args(
            "themes.errors.archiveTooLarge",
            &[("limit", &(MAX_ARCHIVE_BYTES / 1024 / 1024).to_string())],
        ));
    }
    let file = File::open(archive_path).map_err(|error| {
        error_args(
            "themes.errors.archiveInvalid",
            &[("error", &error.to_string())],
        )
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        error_args(
            "themes.errors.archiveInvalid",
            &[("error", &error.to_string())],
        )
    })?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(error_key("themes.errors.tooManyEntries"));
    }

    let mut entries: BTreeMap<String, usize> = BTreeMap::new();
    let mut total_declared: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            error_args(
                "themes.errors.archiveInvalid",
                &[("error", &error.to_string())],
            )
        })?;
        if entry.is_dir() {
            continue;
        }
        let raw_name = entry.name().map_err(|error| {
            error_args(
                "themes.errors.archiveInvalid",
                &[("error", &error.to_string())],
            )
        })?;
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(error_args(
                    "themes.errors.unsafeEntry",
                    &[("path", raw_name.as_ref())],
                ));
            }
        }
        if entries.len() >= MAX_ARCHIVE_ENTRIES {
            return Err(error_key("themes.errors.tooManyEntries"));
        }
        let normalized = raw_name.replace('\\', "/");
        let name = safe_relative(&normalized)?;
        if entries.insert(name.clone(), index).is_some() {
            return Err(error_args(
                "themes.errors.duplicateEntry",
                &[("path", &name)],
            ));
        }
        total_declared = total_declared.saturating_add(entry.size());
    }
    if total_declared > MAX_EXTRACTED_BYTES {
        return Err(error_args(
            "themes.errors.archiveTooLarge",
            &[("limit", &(MAX_ARCHIVE_BYTES / 1024 / 1024).to_string())],
        ));
    }

    let mut candidates: Vec<(String, String)> = Vec::new();
    for name in entries.keys() {
        if name == THEME_MANIFEST {
            candidates.push((String::new(), name.clone()));
        } else if let Some(prefix) = name.strip_suffix("/theme.json") {
            if !prefix.is_empty() && !prefix.contains('/') {
                candidates.push((prefix.to_string(), name.clone()));
            }
        }
    }
    if candidates.is_empty() {
        return Err(error_key("themes.errors.manifestMissing"));
    }
    if candidates.len() > 1 {
        return Err(error_key("themes.errors.manifestAmbiguous"));
    }
    let (base, manifest_name) = candidates.remove(0);
    let base_prefix = if base.is_empty() {
        String::new()
    } else {
        format!("{base}/")
    };
    let manifest_index = *entries
        .get(&manifest_name)
        .ok_or_else(|| error_key("themes.errors.manifestMissing"))?;
    let manifest_bytes = read_capped(&mut archive, manifest_index, MAX_MANIFEST_BYTES)?
        .ok_or_else(|| {
            error_args(
                "themes.errors.manifestTooLarge",
                &[("limit", &(MAX_MANIFEST_BYTES / 1024).to_string())],
            )
        })?;
    let manifest_size = manifest_bytes.len() as u64;
    let raw = String::from_utf8(manifest_bytes).map_err(|error| {
        error_args(
            "themes.errors.manifestInvalid",
            &[("error", &error.to_string())],
        )
    })?;
    let manifest = parse_manifest(&raw)?;
    if is_builtin_theme_id(&manifest.id) || manifest.id.starts_with(PLUGIN_THEME_ID_PREFIX) {
        return Err(error_key("themes.errors.reservedId"));
    }

    let mut assets: Vec<(String, AssetKind, Vec<u8>)> = Vec::new();
    let mut asset_paths: BTreeSet<String> = BTreeSet::new();
    let mut font_refs: Vec<(&str, AssetKind)> = Vec::new();
    if let Some(path) = manifest.fonts.sans.as_deref() {
        font_refs.push((path, AssetKind::Font));
    }
    if let Some(path) = manifest.fonts.mono.as_deref() {
        font_refs.push((path, AssetKind::Font));
    }
    let mut image_refs: Vec<&str> = Vec::new();
    if let Some(path) = manifest.wallpaper.light.as_deref() {
        image_refs.push(path);
    }
    if let Some(path) = manifest.wallpaper.dark.as_deref() {
        image_refs.push(path);
    }
    for (relative, kind) in font_refs
        .into_iter()
        .chain(image_refs.into_iter().map(|path| (path, AssetKind::Image)))
    {
        let Some(&index) = entries.get(&format!("{base_prefix}{relative}")) else {
            return Err(error_args(
                "themes.errors.assetMissing",
                &[("asset", relative)],
            ));
        };
        let limit = match kind {
            AssetKind::Image => MAX_WALLPAPER_BYTES,
            AssetKind::Font => MAX_FONT_BYTES,
        };
        let Some(bytes) = read_capped(&mut archive, index, limit)? else {
            return Err(error_args(
                "themes.errors.assetTooLarge",
                &[("asset", relative)],
            ));
        };
        validate_asset_bytes(relative, kind, &bytes)?;
        if asset_paths.insert(relative.to_string()) {
            assets.push((relative.to_string(), kind, bytes));
        }
    }
    let total_extracted = manifest_size
        + assets
            .iter()
            .map(|(_, _, bytes)| bytes.len() as u64)
            .sum::<u64>();
    if total_extracted > MAX_EXTRACTED_BYTES {
        return Err(error_args(
            "themes.errors.archiveTooLarge",
            &[("limit", &(MAX_ARCHIVE_BYTES / 1024 / 1024).to_string())],
        ));
    }

    let themes = themes_dir(data_dir);
    fs::create_dir_all(&themes).map_err(|error| {
        error_args(
            "themes.errors.createThemesDir",
            &[("error", &error.to_string())],
        )
    })?;
    let temp = themes.join(format!(".install-{}", Uuid::new_v4()));
    let write_result = (|| -> Result<(), String> {
        fs::create_dir_all(&temp).map_err(|error| {
            error_args(
                "themes.errors.installFailed",
                &[("error", &error.to_string())],
            )
        })?;
        let manifest_json = serde_json::to_vec_pretty(&manifest).map_err(|error| {
            error_args(
                "themes.errors.installFailed",
                &[("error", &error.to_string())],
            )
        })?;
        fs::write(temp.join(THEME_MANIFEST), manifest_json).map_err(|error| {
            error_args(
                "themes.errors.installFailed",
                &[("error", &error.to_string())],
            )
        })?;
        for (relative, _, bytes) in &assets {
            let target = temp.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    error_args(
                        "themes.errors.installFailed",
                        &[("error", &error.to_string())],
                    )
                })?;
            }
            fs::write(&target, bytes).map_err(|error| {
                error_args(
                    "themes.errors.installFailed",
                    &[("error", &error.to_string())],
                )
            })?;
        }
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_dir_all(&temp);
        return Err(error);
    }

    let target = themes.join(&manifest.id);
    let replaced = target.exists();
    let move_result = if replaced {
        let backup = themes.join(format!(".old-{}", Uuid::new_v4()));
        fs::rename(&target, &backup).map_err(|error| {
            error_args(
                "themes.errors.installFailed",
                &[("error", &error.to_string())],
            )
        })?;
        match fs::rename(&temp, &target) {
            Ok(()) => {
                let _ = remove_path(&backup);
                Ok(())
            }
            Err(error) => {
                let _ = fs::rename(&backup, &target);
                let _ = fs::remove_dir_all(&temp);
                Err(error_args(
                    "themes.errors.installFailed",
                    &[("error", &error.to_string())],
                ))
            }
        }
    } else {
        fs::rename(&temp, &target).map_err(|error| {
            let _ = fs::remove_dir_all(&temp);
            error_args(
                "themes.errors.installFailed",
                &[("error", &error.to_string())],
            )
        })
    };
    move_result?;

    Ok(ThemeInstallResult {
        theme: info_from_manifest(&manifest),
        replaced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn required_palette(accent: &str) -> String {
        let mut tokens = String::new();
        for token in required_tokens() {
            tokens.push_str(&format!("\"{token}\":\"{accent}\","));
        }
        format!("{{{}}}", tokens.trim_end_matches(','))
    }

    fn manifest(id: &str) -> String {
        manifest_with_assets(id, "")
    }

    fn manifest_with_assets(id: &str, extra: &str) -> String {
        format!(
            r#"{{
                "schemaVersion": 1,
                "id": "{id}",
                "name": "Ocean",
                "tokens": {{
                    "light": {},
                    "dark": {}
                }}{extra}
            }}"#,
            required_palette("#112233"),
            required_palette("#445566")
        )
    }

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        let file = File::create(path).expect("create zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, bytes) in files {
            writer.start_file(*name, options).expect("start file");
            writer.write_all(bytes).expect("write file");
        }
        writer.finish().expect("finish zip");
    }

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn validates_required_tokens_for_both_variants() {
        let mut parsed = parse_manifest(&manifest("ocean")).expect("valid manifest");
        assert_eq!(parsed.id, "ocean");
        assert_eq!(parsed.version, "1.0.0");
        assert!(parsed.tokens.light.contains_key("background"));
    }

    #[test]
    fn rejects_unknown_tokens_and_bad_values() {
        let unknown = manifest("ocean").replace("\"accent\"", "\"nope\"");
        assert!(parse_manifest(&unknown).is_err());

        let bad_color = manifest("ocean").replacen("\"#112233\"", "\"url(http://x)\"", 1);
        assert!(parse_manifest(&bad_color).is_err());

        let missing = manifest("ocean").replace("\"border\":", "\"bordr\":");
        assert!(parse_manifest(&missing).is_err());
    }

    #[test]
    fn rejects_reserved_and_malformed_ids() {
        assert!(parse_manifest(&manifest("Zylara")).is_err());
        assert!(is_valid_theme_id("ocean-2"));
        assert!(is_valid_theme_id(BUILTIN_THEME_ID));
        assert!(!is_valid_theme_id("../ocean"));
        assert!(!is_valid_theme_id(""));
    }

    #[test]
    fn install_extracts_single_wrapper_and_assets() {
        let dir = temp_dir();
        let zip_path = dir.path().join("theme.zip");
        let png = base64::engine::general_purpose::STANDARD
            .decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            )
            .expect("1x1 png");
        write_zip(
            &zip_path,
            &[
                (
                    "ocean/theme.json",
                    manifest_with_assets(
                        "ocean",
                        r#","wallpaper":{"light":"images/bg.png","dark":"images/bg.png"}"#,
                    )
                    .as_bytes(),
                ),
                ("ocean/images/bg.png", &png),
            ],
        );

        let result = install_theme(dir.path(), &zip_path).expect("install");
        assert!(!result.replaced);
        assert!(dir.path().join("themes/ocean/theme.json").is_file());
        assert!(dir.path().join("themes/ocean/images/bg.png").is_file());
        let listed = list_themes(dir.path());
        assert!(listed.iter().any(|theme| theme.id == "ocean" && !theme.built_in));
    }

    #[test]
    fn bundled_themes_are_complete_and_ordered() {
        let dir = temp_dir();
        let listed = list_themes(dir.path());
        let ids: Vec<&str> = listed.iter().map(|theme| theme.id.as_str()).collect();
        assert_eq!(
            ids,
            ["zylara", "aurora", "ember", "grove", "nebula", "nocturne"]
        );
        for theme in &listed[1..] {
            assert!(theme.built_in);
            for variant in [&theme.light, &theme.dark] {
                for token in required_tokens() {
                    assert!(
                        variant.tokens.contains_key(token),
                        "{} missing {token}",
                        theme.id
                    );
                }
            }
        }
    }

    #[test]
    fn bundled_themes_share_the_radius_scale() {
        // The bundled themes must use the same scale as the built-in Zylara
        // defaults in `src/styles/globals.css`.
        let expected = [
            ("radius-xs", "2px"),
            ("radius-sm", "2px"),
            ("radius-md", "4px"),
            ("radius-lg", "6px"),
            ("radius-xl", "8px"),
            ("radius-2xl", "10px"),
            ("radius-3xl", "12px"),
        ];
        let dir = temp_dir();
        let listed = list_themes(dir.path());
        assert!(listed.iter().any(|theme| theme.id == BUILTIN_THEME_ID));
        for theme in listed.iter().filter(|theme| theme.id != BUILTIN_THEME_ID) {
            for variant in [&theme.light, &theme.dark] {
                for &(token, value) in &expected {
                    assert_eq!(
                        variant.tokens.get(token).map(String::as_str),
                        Some(value),
                        "{} {} differs from the shared scale",
                        theme.id,
                        token
                    );
                }
            }
        }
        let builtin = builtin_theme();
        assert!(builtin.light.tokens.is_empty());
        assert!(builtin.dark.tokens.is_empty());
    }

    #[test]
    fn install_rejects_every_reserved_builtin_id() {
        let dir = temp_dir();
        for id in [BUILTIN_THEME_ID, "aurora", "ember", "grove", "nebula", "nocturne"] {
            let zip_path = dir.path().join(format!("{id}.zip"));
            write_zip(&zip_path, &[("theme.json", manifest(id).as_bytes())]);
            assert!(install_theme(dir.path(), &zip_path).is_err(), "{id} accepted");
        }
    }

    #[test]
    fn install_rejects_traversal_and_duplicates() {
        let dir = temp_dir();
        let zip_path = dir.path().join("theme.zip");
        write_zip(
            &zip_path,
            &[
                ("theme.json", manifest("ocean").as_bytes()),
                ("../evil.png", b"x"),
            ],
        );
        assert!(install_theme(dir.path(), &zip_path).is_err());

        let duplicates = dir.path().join("duplicates.zip");
        write_zip(
            &duplicates,
            &[
                ("theme.json", manifest("ocean").as_bytes()),
                ("./theme.json", manifest("ocean").as_bytes()),
            ],
        );
        assert!(install_theme(dir.path(), &duplicates).is_err());
    }

    #[test]
    fn install_replaces_existing_theme_atomically() {
        let dir = temp_dir();
        let first = dir.path().join("first.zip");
        write_zip(&first, &[("theme.json", manifest("ocean").as_bytes())]);
        assert!(!install_theme(dir.path(), &first).expect("first").replaced);

        let second = dir.path().join("second.zip");
        write_zip(&second, &[("theme.json", manifest("ocean").as_bytes())]);
        let result = install_theme(dir.path(), &second).expect("second");
        assert!(result.replaced);
        assert!(dir.path().join("themes/ocean/theme.json").is_file());
    }

    #[test]
    fn asset_requires_safe_path_and_file() {
        let dir = temp_dir();
        let themes = themes_dir(dir.path());
        fs::create_dir_all(themes.join("ocean/images")).expect("theme dir");
        fs::write(themes.join("ocean/images/bg.png"), b"png").expect("asset");

        let url = theme_asset(dir.path(), "ocean", "images/bg.png").expect("asset");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(theme_asset(dir.path(), "ocean", "../theme.json").is_err());
        assert!(theme_asset(dir.path(), "ocean", "theme.json").is_err());
        assert!(theme_asset(dir.path(), "ocean", "images/missing.png").is_err());
        assert!(theme_asset(dir.path(), BUILTIN_THEME_ID, "x.png").is_err());
    }

    #[test]
    fn list_skips_invalid_directories_and_keeps_builtin_first() {
        let dir = temp_dir();
        let themes = themes_dir(dir.path());
        fs::create_dir_all(themes.join("bad")).expect("bad dir");
        fs::write(themes.join("bad/theme.json"), b"not json").expect("bad manifest");
        fs::create_dir_all(themes.join("ocean")).expect("theme dir");
        fs::write(themes.join("ocean/theme.json"), manifest("ocean")).expect("manifest");

        let listed = list_themes(dir.path());
        assert_eq!(listed[0].id, BUILTIN_THEME_ID);
        // Zylara + Aurora + Ember + Grove + Nebula + Nocturne + the valid installed theme.
        assert_eq!(listed.len(), 7);
        let installed = listed
            .iter()
            .find(|theme| theme.id == "ocean")
            .expect("installed theme");
        assert!(!installed.built_in);
        assert!(!listed.iter().any(|theme| theme.id == "bad"));
    }

    #[test]
    fn plugin_theme_namespace_is_reserved_for_contributions() {
        assert!(is_valid_theme_id("plugin-0123456789abcdef"));

        let dir = temp_dir();
        let zip_path = dir.path().join("plugin-theme.zip");
        write_zip(
            &zip_path,
            &[(
                "plugin-feedface/theme.json",
                manifest("plugin-feedface").as_bytes(),
            )],
        );
        assert!(install_theme(dir.path(), &zip_path).is_err());

        let themes = themes_dir(dir.path());
        fs::create_dir_all(themes.join("plugin-deadbeef")).expect("theme dir");
        fs::write(
            themes.join("plugin-deadbeef/theme.json"),
            manifest("plugin-deadbeef"),
        )
        .expect("manifest");
        assert!(list_themes(dir.path())
            .iter()
            .all(|theme| !theme.id.starts_with(PLUGIN_THEME_ID_PREFIX)));
        assert!(uninstall_theme(dir.path(), "plugin-deadbeef").is_err());
    }

    #[test]
    fn contributed_tokens_use_the_host_allowlist() {
        let mut tokens = BTreeMap::new();
        tokens.insert("--accent".to_string(), "#8b5cf6".to_string());
        tokens.insert("surface".to_string(), "#faf9ff".to_string());
        assert!(validate_contributed_tokens("light", &tokens, "paper").is_ok());

        tokens.insert("dangerous-token".to_string(), "red".to_string());
        assert!(validate_contributed_tokens("light", &tokens, "paper").is_err());

        let mut invalid = BTreeMap::new();
        invalid.insert("accent".to_string(), "url(https://example.com)".to_string());
        assert!(validate_contributed_tokens("dark", &invalid, "paper").is_err());
    }
}
