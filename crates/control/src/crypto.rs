use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    Tag, XChaCha20Poly1305, XNonce,
    aead::{AeadInPlace, KeyInit},
};
use hmac::{Hmac, Mac};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

type HmacSha256 = Hmac<Sha256>;

const KEY_ID_DOMAIN: &[u8] = b"hostlet-secret-key-id/v1\0";
const REPLAY_KEY_DOMAIN: &[u8] = b"hostlet-secret-replay-key/v1\0";

pub struct SecretKey {
    bytes: [u8; 32],
    key_version: String,
}

pub(crate) struct EncryptedValue {
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
    pub auth_tag: [u8; 16],
}

pub(crate) enum CryptoError {
    EncryptionFailed,
    AuthenticationFailed,
}

impl SecretKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        let mut digest = Sha256::new();
        digest.update(KEY_ID_DOMAIN);
        digest.update(bytes);
        let identifier = digest.finalize();
        let key_version = format!("v1-{}", URL_SAFE_NO_PAD.encode(identifier));
        Self { bytes, key_version }
    }

    pub fn key_version(&self) -> &str {
        &self.key_version
    }

    pub(crate) fn encrypt(
        &self,
        additional_data: &[u8],
        plaintext: &[u8],
    ) -> Result<EncryptedValue, CryptoError> {
        let cipher = XChaCha20Poly1305::new_from_slice(&self.bytes)
            .map_err(|_| CryptoError::EncryptionFailed)?;
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let mut ciphertext = plaintext.to_vec();
        let tag = match cipher.encrypt_in_place_detached(
            XNonce::from_slice(&nonce),
            additional_data,
            &mut ciphertext,
        ) {
            Ok(tag) => tag,
            Err(_) => {
                ciphertext.zeroize();
                return Err(CryptoError::EncryptionFailed);
            }
        };
        let mut auth_tag = [0_u8; 16];
        auth_tag.copy_from_slice(tag.as_slice());
        Ok(EncryptedValue {
            nonce,
            ciphertext,
            auth_tag,
        })
    }

    pub(crate) fn decrypt(
        &self,
        additional_data: &[u8],
        nonce: &[u8],
        ciphertext: &[u8],
        auth_tag: &[u8],
    ) -> Result<Vec<u8>, CryptoError> {
        let nonce: &[u8; 24] = nonce
            .try_into()
            .map_err(|_| CryptoError::AuthenticationFailed)?;
        let auth_tag: &[u8; 16] = auth_tag
            .try_into()
            .map_err(|_| CryptoError::AuthenticationFailed)?;
        let cipher = XChaCha20Poly1305::new_from_slice(&self.bytes)
            .map_err(|_| CryptoError::AuthenticationFailed)?;
        let mut plaintext = ciphertext.to_vec();
        if cipher
            .decrypt_in_place_detached(
                XNonce::from_slice(nonce),
                additional_data,
                &mut plaintext,
                Tag::from_slice(auth_tag),
            )
            .is_err()
        {
            plaintext.zeroize();
            return Err(CryptoError::AuthenticationFailed);
        }
        Ok(plaintext)
    }

    pub(crate) fn replay_fingerprint(&self, canonical_request: &[u8]) -> [u8; 32] {
        let mut derivation =
            <HmacSha256 as Mac>::new_from_slice(&self.bytes).expect("HMAC accepts a 32-byte key");
        derivation.update(REPLAY_KEY_DOMAIN);
        let mut derived_key = derivation.finalize().into_bytes();
        let mut fingerprint =
            <HmacSha256 as Mac>::new_from_slice(&derived_key).expect("HMAC accepts a 32-byte key");
        derived_key.zeroize();
        fingerprint.update(canonical_request);
        let fingerprint = fingerprint.finalize().into_bytes();
        let mut output = [0_u8; 32];
        output.copy_from_slice(&fingerprint);
        output
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.bytes.zeroize();
    }
}
