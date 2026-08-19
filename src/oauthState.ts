import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';

/**
 * Self-contained, AEAD-encrypted "state" token for the Gmail account-linking flow.
 *
 * The PKCE code_verifier and alias travel inside this token rather than in
 * server-side session storage: Cloud Run may route the callback to a different
 * instance than the one that started the flow, so the token must be independently
 * verifiable by any instance with no shared state. It is short-lived (10 minutes)
 * and single-purpose.
 *
 * This is AES-256-GCM authenticated ENCRYPTION, not just an HMAC signature: the
 * token also travels as a URL query parameter on both legs of the Google OAuth
 * redirect (to accounts.google.com and back), where it could plausibly be
 * observed by something other than the two intended parties — browser history,
 * or Cloud Run's own request logging, which records full request URLs including
 * query strings. A merely-signed-but-plaintext token would let anyone who reads
 * such a log recover the code_verifier and re-run the token exchange against a
 * Google account of their own choosing, silently overwriting the target alias
 * with an attacker-controlled Gmail account. Encrypting the payload means the
 * token is opaque to anyone without OAUTH_STATE_SECRET, closing that off; GCM's
 * authentication tag still gives the same tamper-evidence an HMAC would.
 *
 * This does not add single-use/replay tracking (which would require shared
 * state across Cloud Run instances). That's an accepted trade-off, not an
 * oversight: once the payload is confidential, replaying a state token requires
 * also replaying a Google authorization `code` for the same PKCE challenge, and
 * Google's own authorization server already rejects a `code` on a second use.
 */

interface StatePayload {
  alias: string;
  codeVerifier: string;
  exp: number;
}

const TTL_MS = 10 * 60 * 1000;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function deriveKey(): Buffer {
  // OAUTH_STATE_SECRET is an arbitrary-length random string; hash it down to
  // exactly 32 bytes for use as an AES-256 key.
  return createHash('sha256').update(loadConfig().oauthStateSecret).digest();
}

export function createState(alias: string, codeVerifier: string): string {
  const payload: StatePayload = { alias, codeVerifier, exp: Date.now() + TTL_MS };
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url');
}

export class InvalidStateError extends Error {}

export function verifyState(token: string): StatePayload {
  let raw: Buffer;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    throw new InvalidStateError('Malformed state token.');
  }
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new InvalidStateError('Malformed state token.');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  let payload: StatePayload;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    payload = JSON.parse(plaintext.toString('utf8')) as StatePayload;
  } catch {
    // Wrong key, tampered ciphertext, tampered auth tag, or invalid JSON all land
    // here — decipher.final() throws on any authentication failure.
    throw new InvalidStateError('State token is invalid or has been tampered with.');
  }

  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    throw new InvalidStateError('State token has expired. Please restart the connection from the admin page.');
  }
  return payload;
}
