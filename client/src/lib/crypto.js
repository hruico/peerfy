export async function sha256hex(buffer) {
  const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ECDH key exchange - P-256, non-extractable private key

export async function generateECDHKeypair() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"]
  );
  const raw      = await crypto.subtle.exportKey("raw", publicKey);
  const exported = _toBase64url(raw);
  return { privateKey, publicKey, exported };
}

export async function importECDHPublicKey(base64url) {
  const raw = _fromBase64url(base64url);
  return crypto.subtle.importKey(
    "raw", raw,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );
}

// Both sides derive the same AES-GCM-256 key - no key material is ever transmitted.
export async function deriveSharedKey(myPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPublicKey },
    myPrivateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// AES-GCM chunk encryption

export async function encryptChunk(key, plaintext) {
  const iv         = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv, ciphertext };
}

export async function decryptChunk(key, iv, ciphertext) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
}

function _toBase64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function _fromBase64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
