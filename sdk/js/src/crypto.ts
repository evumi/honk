// End-to-end encryption, byte-compatible with Honk's apps: AES-256-GCM, the
// bot's short id as additional data, written as the unpadded base64url text of
// nonce(12) || ciphertext || tag(16). Web Crypto only, so it runs on Node 20+,
// Bun, Deno, browsers and Workers alike.

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Decodes base64 or base64url text, padded or not. */
export function fromBase64(text: string): Uint8Array {
  const s = text.trim().replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error("not base64");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encodes bytes as unpadded base64url. */
export function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodes the bot key the app shows in the bot's settings: 32 bytes of
 * base64, standard or URL alphabet, padded or not.
 */
export function parseKey(text: string): Uint8Array {
  let key: Uint8Array;
  try {
    key = fromBase64(text);
  } catch {
    throw new Error("key is not base64");
  }
  if (key.length !== 32) throw new Error(`key must be 32 bytes, got ${key.length}`);
  return key;
}

async function importKey(key: Uint8Array | CryptoKey): Promise<CryptoKey> {
  if (!(key instanceof Uint8Array)) return key;
  if (key.length !== 32) throw new Error(`key must be 32 bytes, got ${key.length}`);
  return crypto.subtle.importKey("raw", key as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seals plaintext the way Honk's apps open it. `aad` is the bot's short id. */
export async function seal(key: Uint8Array | CryptoKey, aad: string, plaintext: string): Promise<string> {
  const k = await importKey(key);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(aad) }, k, enc.encode(plaintext)),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return toBase64url(out);
}

/** Reverses {@link seal}. */
export async function open(key: Uint8Array | CryptoKey, aad: string, text: string): Promise<string> {
  const k = await importKey(key);
  const raw = fromBase64(text) as Uint8Array<ArrayBuffer>;
  if (raw.length < 12 + 16) throw new Error("ciphertext is too short");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: enc.encode(aad) },
    k,
    raw.subarray(12),
  );
  return dec.decode(plain);
}
