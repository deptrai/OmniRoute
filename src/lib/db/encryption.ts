/**
 * Field-Level Encryption — AES-256-GCM
 *
 * Encrypts/decrypts sensitive fields (API keys, tokens) stored in SQLite.
 * Format: `enc:v1:<iv_hex>:<ciphertext_hex>:<authTag_hex>`
 *
 * If STORAGE_ENCRYPTION_KEY is not set, operates in passthrough mode
 * (stores plaintext for development convenience).
 *
 * KEY DERIVATION CHANGE (v3.7.9):
 * The PRIMARY key is now derived with a static salt ("omniroute-field-encryption-v1").
 * The LEGACY key used a dynamic salt (sha256 hash of the key). Auto-migration
 * re-encrypts any legacy-encrypted tokens on decrypt.
 *
 * Why the change?
 * The dynamic salt `createHash("sha256").update(secret).digest().slice(0, 16)` produced
 * a different derived key than the static salt `"omniroute-field-encryption-v1"`. When the
 * health-check/token-refresh path used one derivation and the main API used another,
 * tokens encrypted by one path became undecryptable by the other, causing:
 * - Persistent decrypt failures
 * - Re-encryption loops (health-check undoing fixes)
 * - CPU spikes (50%) from error cascades
 *
 * This fix makes the static salt the primary derivation and auto-migrates
 * legacy-encrypted tokens back to static-salt encryption.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
/**
 * GCM authentication tag length, in bytes. Pinned to the full 16-byte tag
 * produced by `cipher.getAuthTag()`. Passing `authTagLength` to
 * `createDecipheriv` rejects truncated authentication tags up front, closing
 * the GCM tag-truncation forgery vector (Semgrep gcm-no-tag-length).
 */
const AUTH_TAG_LENGTH = 16;
const PREFIX = "enc:v1:";
const STATIC_SALT = "omniroute-field-encryption-v1";

let _staticKey: Buffer | null = null;
let _legacyDynamicKey: Buffer | null = null;
let _rawKey: Buffer | null = null;
/** Connection object with potentially encrypted credential fields. */
export interface ConnectionFields {
  apiKey?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  idToken?: string | null;
  [key: string]: unknown;
}

/**
 * Derive the PRIMARY encryption key using the static salt.
 * This is the canonical key derivation that all new encryptions use.
 * Returns null if no encryption key is configured.
 */
function getStaticKey(): Buffer | null {
  if (_staticKey !== null) return _staticKey;

  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) return null;

  try {
    _staticKey = scryptSync(secret, STATIC_SALT, KEY_LENGTH);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[Encryption] Failed to derive key from STORAGE_ENCRYPTION_KEY: ${message}. ` +
        `Generate a valid key with: openssl rand -base64 32`
    );
    return null;
  }
  return _staticKey;
}

/**
 * Derive the LEGACY key using the old dynamic salt method.
 * Used exclusively for fallback decryption of tokens encrypted by older versions.
 *
 * The old dynamic salt was: createHash("sha256").update(secret).digest().slice(0, 16)
 * This produced a different derived key than the static salt, causing incompatibility.
 */
function getLegacyDynamicKey(): Buffer | null {
  if (_legacyDynamicKey !== null) return _legacyDynamicKey;

  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) return null;

  const dynamicSalt = createHash("sha256").update(secret).digest().slice(0, 16);
  try {
    _legacyDynamicKey = scryptSync(secret, dynamicSalt, KEY_LENGTH);
  } catch {
    return null;
  }
  return _legacyDynamicKey;
}

/**
 * Derive a RAW key by treating STORAGE_ENCRYPTION_KEY as the key material itself.
 *
 * Very old tokens (pre v3.7.9, including some Windsurf provider rows) were
 * encrypted by taking the hex-encoded or base64-encoded 32-byte secret and using
 * it directly as the AES-256-GCM key, with the auth tag placed BEFORE the
 * ciphertext (iv:tag:enc). This fallback supports those legacy rows so they can
 * be migrated to the canonical static-salt format on the next write.
 */
function getRawKey(): Buffer | null {
  if (_rawKey !== null) return _rawKey;

  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) return null;

  // Hex-encoded 32-byte key: 64 hex characters.
  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    _rawKey = Buffer.from(secret, "hex");
  } else if (secret.length === 44) {
    // Base64-encoded 32-byte key: 44 characters (openssl rand -base64 32).
    try {
      const decoded = Buffer.from(secret, "base64");
      if (decoded.length === KEY_LENGTH) _rawKey = decoded;
    } catch {
      _rawKey = null;
    }
  } else {
    _rawKey = null;
  }

  return _rawKey;
}

/** Check if encryption is enabled. */
export function isEncryptionEnabled(): boolean {
  return !!process.env.STORAGE_ENCRYPTION_KEY;
}

/**
 * Encrypt a plaintext string using the STATIC salt key.
 * If encryption is not configured, returns plaintext unchanged.
 */
export function encrypt(plaintext: string | null | undefined): string | null | undefined {
  if (!plaintext || typeof plaintext !== "string") return plaintext;

  const key = getStaticKey();
  if (!key) {
    console.warn(
      "[Encryption] STORAGE_ENCRYPTION_KEY not set. Storing plaintext (passthrough mode)."
    );
    return plaintext; // passthrough mode
  }

  // Already encrypted — don't double-encrypt
  if (plaintext.startsWith(PREFIX)) return plaintext;

  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return `${PREFIX}${iv.toString("hex")}:${encrypted}:${authTag}`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[Encryption] Encryption failed: ${message}. ` +
        `Check your STORAGE_ENCRYPTION_KEY — generate one with: openssl rand -base64 32`
    );
    return plaintext; // fallback to plaintext rather than crashing
  }
}

function tryDecipher(key: Buffer, iv: Buffer, encrypted: Buffer, authTag: Buffer): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Try a key against both the canonical `iv:enc:tag` format and the legacy
 * `iv:tag:enc` format. GCM tag validation keeps us from misinterpreting the
 * ciphertext as the tag, so we can safely attempt both orderings.
 */
function tryBothFormats(
  candidateKey: Buffer | null,
  ivHex: string,
  a: string,
  b: string
): string | null {
  if (!candidateKey) return null;

  const iv = Buffer.from(ivHex, "hex");
  if (iv.length === 0) return null;

  const tagA = a.length === AUTH_TAG_LENGTH * 2 ? Buffer.from(a, "hex") : null;
  const tagB = b.length === AUTH_TAG_LENGTH * 2 ? Buffer.from(b, "hex") : null;
  const encA = Buffer.from(a, "hex");
  const encB = Buffer.from(b, "hex");

  // Canonical format: a = ciphertext, b = auth tag.
  if (tagB) {
    const r = tryDecipher(candidateKey, iv, encA, tagB);
    if (r !== null) return r;
  }

  // Legacy format: a = auth tag, b = ciphertext.
  if (tagA) {
    const r = tryDecipher(candidateKey, iv, encB, tagA);
    if (r !== null) return r;
  }

  // No plausible 16-byte tag visible (should not happen for GCM), but try anyway.
  if (!tagA && !tagB) {
    const r1 = tryDecipher(candidateKey, iv, encA, encB);
    if (r1 !== null) return r1;
    const r2 = tryDecipher(candidateKey, iv, encB, encA);
    if (r2 !== null) return r2;
  }

  return null;
}

/**
 * Decrypt a ciphertext string. Attempts static-salt key first (primary),
 * then falls back to legacy dynamic-salt key and raw key for backward
 * compatibility. Also accepts both the canonical `iv:enc:tag` layout and the
 * legacy `iv:tag:enc` layout.
 *
 * When a token is decrypted using a non-primary key, the next encrypt() call
 * (e.g. from token health-check or connection upsert) will re-encrypt it with
 * the static-salt key, gradually migrating the database.
 */
export function decrypt(ciphertext: string | null | undefined): string | null | undefined {
  if (!ciphertext || typeof ciphertext !== "string") return ciphertext;

  // Not encrypted — return as-is (legacy plaintext or passthrough mode)
  if (!ciphertext.startsWith(PREFIX)) return ciphertext;

  const staticKey = getStaticKey();
  if (!staticKey) {
    console.warn(
      "[Encryption] Found encrypted data but STORAGE_ENCRYPTION_KEY is not set. Cannot decrypt."
    );
    return null;
  }

  const body = ciphertext.slice(PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3) {
    console.error("[Encryption] Malformed encrypted value");
    return null;
  }

  const [ivHex, a, b] = parts;

  const decrypted =
    tryBothFormats(staticKey, ivHex, a, b) ?? tryBothFormats(getRawKey(), ivHex, a, b) ?? null;

  if (decrypted !== null) {
    return decrypted;
  }

  console.error(
    `[Encryption] Decryption failed. Ciphertext prefix: ${ciphertext.slice(0, 30)}... ` +
      `Auth tag validation likely failed.`
  );
  return null;
}

/**
 * Encrypt sensitive fields in a connection object (mutates in-place).
 * After decryption that required legacy key, re-encrypt with static key
 * to migrate tokens automatically.
 */
export function encryptConnectionFields<T extends ConnectionFields | null | undefined>(conn: T): T {
  if (!isEncryptionEnabled()) return conn;
  if (!conn) return conn;

  if (conn.apiKey) conn.apiKey = encrypt(conn.apiKey);
  if (conn.accessToken) conn.accessToken = encrypt(conn.accessToken);
  if (conn.refreshToken) conn.refreshToken = encrypt(conn.refreshToken);
  if (conn.idToken) conn.idToken = encrypt(conn.idToken);
  return conn;
}

/**
 * Decrypt sensitive fields in a connection row (returns new object).
 * Note: If any field was decrypted using the legacy key, the migration
 * flag is set. The calling code should check isMigrationNeeded() and
 * trigger a re-encrypt (write-back) to migrate those tokens to the static key.
 */
export function decryptConnectionFields<T extends ConnectionFields | null | undefined>(row: T): T {
  if (!row) return row;
  if (!isEncryptionEnabled()) return row;

  return {
    ...row,
    apiKey: decrypt(row.apiKey),
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    idToken: decrypt(row.idToken),
  };
}

/**
 * Specifically tests a ciphertext against the legacy / raw keys. If it
 * succeeds, it re-encrypts the decrypted value with the canonical static key.
 * Used exclusively by the startup migration script.
 */
export function migrateLegacyEncryptedString(ciphertext: string | null | undefined): {
  updated: boolean;
  value: string | null | undefined;
} {
  if (!isEncryptionEnabled()) return { updated: false, value: ciphertext };
  if (!ciphertext || ciphertext.trim().length === 0) return { updated: false, value: ciphertext };
  if (!ciphertext.startsWith(PREFIX)) return { updated: false, value: ciphertext };

  const staticKey = getStaticKey();
  if (!staticKey) return { updated: false, value: null };

  const rawPayload = ciphertext.slice(PREFIX.length);
  const parts = rawPayload.split(":");
  if (parts.length !== 3) return { updated: false, value: ciphertext };

  const [ivHex, a, b] = parts;

  // 1. If it already decrypts with the static key, no migration needed.
  if (tryBothFormats(staticKey, ivHex, a, b) !== null) {
    return { updated: false, value: ciphertext };
  }

  // 2. If it decrypts with a legacy or raw key, re-encrypt with the canonical key.
  const legacyKey = getLegacyDynamicKey();
  const rawKey = getRawKey();
  for (const candidateKey of [legacyKey, rawKey]) {
    const legacyDecrypted = tryBothFormats(candidateKey, ivHex, a, b);
    if (legacyDecrypted !== null) {
      return { updated: true, value: encrypt(legacyDecrypted) };
    }
  }

  // 3. Un-decryptable or corrupted, leave it alone
  return { updated: false, value: ciphertext };
}
