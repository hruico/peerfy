/** Compute SHA-256 of an ArrayBuffer and return a hex string. */
export async function sha256hex(buffer) {
  const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a new AES-GCM-256 key.
 * Returns { key: CryptoKey, exported: base64url string }
 */
export async function generateAESKey() {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const raw      = await crypto.subtle.exportKey("raw", key);
  const exported = btoa(String.fromCharCode(...new Uint8Array(raw)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); // base64url
  return { key, exported };
}

/**
 * Import a base64url AES-GCM key string back into a CryptoKey.
 * Both encrypt and decrypt are granted — any vault member can upload or download.
 */
export async function importAESKey(base64url) {
  const b64   = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw   = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt an ArrayBuffer chunk with AES-GCM.
 * Returns { iv: Uint8Array(12), ciphertext: ArrayBuffer }
 */
export async function encryptChunk(key, plaintext) {
  const iv         = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv, ciphertext };
}

/**
 * Decrypt an AES-GCM encrypted chunk.
 * iv must be a Uint8Array(12), ciphertext an ArrayBuffer.
 */
export async function decryptChunk(key, iv, ciphertext) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}
