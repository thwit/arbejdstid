import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';

// Keep PBKDF2_ITERATIONS in sync with the client-side value in app.js.
export const PBKDF2_ITERATIONS = 250000;
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // recommended for GCM
const SALT_LENGTH = 16;

// Encrypts `plaintext` with a key derived from `password`, returning a
// JSON-serializable payload the client can decrypt with the same password
// using the Web Crypto API (PBKDF2-SHA256 + AES-256-GCM).
export function encryptWithPassword(plaintext, password) {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    // Web Crypto's AES-GCM expects the auth tag appended to the ciphertext.
    data: Buffer.concat([encrypted, authTag]).toString('base64'),
  };
}

// Decrypts a payload produced by encryptWithPassword (or by app.js's
// client-side Web Crypto encryption, which uses the same layout).
export function decryptWithPassword(payload, password) {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  const combined = Buffer.from(payload.data, 'base64');
  const authTag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(0, combined.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
