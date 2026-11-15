//! Ed25519 signatures for plugin packages and the signed store registry.
//!
//! A signature proves that the bytes came from a publisher key; it does not
//! make a plugin safe. Publisher keys are pinned on first use (TOFU) and a key
//! change is rejected until the user explicitly trusts the new key.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const SIGNATURE_PATH: &str = "META-INF/signature.json";
const SIGNATURE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSignature {
    pub schema_version: u32,
    pub algorithm: String,
    pub publisher_id: String,
    pub key_id: String,
    pub public_key: String,
    pub signature: String,
    /// Lowercase SHA-256 of the canonical package file digest.
    pub package_hash: String,
    #[serde(default)]
    pub signed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySignature {
    pub schema_version: u32,
    pub algorithm: String,
    pub key_id: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedKey {
    pub publisher_id: String,
    pub key_id: String,
    pub public_key: String,
    pub fingerprint: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    let hash = digest.finalize();
    let mut out = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub fn key_fingerprint(public_key: &[u8]) -> String {
    sha256_hex(public_key)
}

fn decode_public_key(encoded: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(encoded.trim())
        .context("publicKey is not valid base64")
}

fn decode_signature(encoded: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(encoded.trim())
        .context("signature is not valid base64")
}

fn verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> Result<()> {
    let key_bytes: [u8; 32] = public_key
        .try_into()
        .map_err(|_| anyhow::anyhow!("publicKey must be 32 bytes"))?;
    let key = VerifyingKey::from_bytes(&key_bytes).context("publicKey is not an Ed25519 key")?;
    let signature =
        Signature::from_slice(signature).map_err(|_| anyhow::anyhow!("signature must be 64 bytes"))?;
    key.verify_strict(message, &signature)
        .map_err(|_| anyhow::anyhow!("Ed25519 signature does not match the payload"))
}

/// Canonical digest of every package file except the detached signature.
///
/// `path\0sha256(file)\0` per file, sorted by path; the SHA-256 of the result is
/// the `packageHash`. Using content hashes instead of the raw ZIP makes the
/// signature independent of the zip writer and its timestamps.
pub fn package_digest(files: &BTreeMap<String, Vec<u8>>) -> String {
    let mut digest = Sha256::new();
    for (path, bytes) in files {
        if path == SIGNATURE_PATH {
            continue;
        }
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(sha256_hex(bytes).as_bytes());
        digest.update([0]);
    }
    let hash = digest.finalize();
    let mut out = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Verifies a package signature and returns the pinned-key identity.
pub fn verify_package(
    files: &BTreeMap<String, Vec<u8>>,
    signature: &PackageSignature,
) -> Result<VerifiedKey> {
    if signature.schema_version != SIGNATURE_SCHEMA_VERSION {
        bail!(
            "signature schemaVersion {} is not supported",
            signature.schema_version
        );
    }
    if signature.algorithm != "ed25519" {
        bail!("signature algorithm `{}` is not supported", signature.algorithm);
    }
    let digest = package_digest(files);
    if signature.package_hash.to_ascii_lowercase() != digest {
        bail!(
            "package hash mismatch: signature says {}, package digest is {}",
            signature.package_hash,
            digest
        );
    }
    let public_key = decode_public_key(&signature.public_key)?;
    let signature_bytes = decode_signature(&signature.signature)?;
    verify(&public_key, digest.as_bytes(), &signature_bytes)?;
    let key_id = signature.key_id.trim();
    if key_id.is_empty() {
        bail!("signature keyId is empty");
    }
    if signature.publisher_id.trim().is_empty() {
        bail!("signature publisherId is empty");
    }
    Ok(VerifiedKey {
        publisher_id: signature.publisher_id.clone(),
        key_id: key_id.to_string(),
        public_key: signature.public_key.clone(),
        fingerprint: key_fingerprint(&public_key),
    })
}

/// Verifies a detached registry signature over canonical JSON bytes.
pub fn verify_registry(canonical_json: &[u8], signature: &RegistrySignature) -> Result<VerifiedKey> {
    if signature.schema_version != SIGNATURE_SCHEMA_VERSION {
        bail!(
            "registry signature schemaVersion {} is not supported",
            signature.schema_version
        );
    }
    if signature.algorithm != "ed25519" {
        bail!("registry signature algorithm is not supported");
    }
    let public_key = decode_public_key(&signature.public_key)?;
    let signature_bytes = decode_signature(&signature.signature)?;
    let digest = sha256_hex(canonical_json);
    verify(&public_key, digest.as_bytes(), &signature_bytes)?;
    Ok(VerifiedKey {
        publisher_id: "registry".to_string(),
        key_id: signature.key_id.clone(),
        public_key: signature.public_key.clone(),
        fingerprint: key_fingerprint(&public_key),
    })
}

/// Signature used by tests and the fixture CLI. Kept in production code so the
/// signing format has exactly one implementation.
pub fn sign_package(
    files: &BTreeMap<String, Vec<u8>>,
    publisher_id: &str,
    key_id: &str,
    signing_key: &ed25519_dalek::SigningKey,
) -> PackageSignature {
    let digest = package_digest(files);
    let signature = ed25519_dalek::Signer::sign(signing_key, digest.as_bytes());
    PackageSignature {
        schema_version: SIGNATURE_SCHEMA_VERSION,
        algorithm: "ed25519".to_string(),
        publisher_id: publisher_id.to_string(),
        key_id: key_id.to_string(),
        public_key: BASE64.encode(signing_key.verifying_key().to_bytes()),
        signature: BASE64.encode(signature.to_bytes()),
        package_hash: digest,
        signed_at: Some(crate::domain::now_ms()),
    }
}

pub fn sign_registry(
    canonical_json: &[u8],
    key_id: &str,
    signing_key: &ed25519_dalek::SigningKey,
) -> RegistrySignature {
    let digest = sha256_hex(canonical_json);
    let signature = ed25519_dalek::Signer::sign(signing_key, digest.as_bytes());
    RegistrySignature {
        schema_version: SIGNATURE_SCHEMA_VERSION,
        algorithm: "ed25519".to_string(),
        key_id: key_id.to_string(),
        public_key: BASE64.encode(signing_key.verifying_key().to_bytes()),
        signature: BASE64.encode(signature.to_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([
            ("manifest.json".to_string(), br#"{"id":"com.acme.test"}"#.to_vec()),
            ("ui/page.html".to_string(), b"<html></html>".to_vec()),
        ])
    }

    #[test]
    fn package_signature_roundtrip_and_tamper_detection() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let signature = sign_package(&files(), "acme", "acme-2026", &key);
        let verified = verify_package(&files(), &signature).expect("valid signature");
        assert_eq!(verified.key_id, "acme-2026");
        assert_eq!(verified.key_fingerprint_len(), 64);

        let mut tampered = files();
        tampered.insert("ui/page.html".into(), b"<html>evil</html>".to_vec());
        assert!(verify_package(&tampered, &signature).is_err());
    }

    #[test]
    fn signature_does_not_cover_its_own_file() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let mut with_extra = files();
        let signature = sign_package(&with_extra, "acme", "k1", &key);
        with_extra.insert(SIGNATURE_PATH.into(), b"ignored".to_vec());
        assert!(verify_package(&with_extra, &signature).is_ok());
    }

    #[test]
    fn a_wrong_key_is_rejected() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[1u8; 32]);
        let other = ed25519_dalek::SigningKey::from_bytes(&[2u8; 32]);
        let mut signature = sign_package(&files(), "acme", "k1", &key);
        signature.public_key = BASE64.encode(other.verifying_key().to_bytes());
        assert!(verify_package(&files(), &signature).is_err());
    }

    trait FingerprintLen {
        fn key_fingerprint_len(&self) -> usize;
    }

    impl FingerprintLen for VerifiedKey {
        fn key_fingerprint_len(&self) -> usize {
            self.fingerprint.len()
        }
    }
}
