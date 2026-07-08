// functions/lib/crypto.js
//
// Encrypt/decrypt helpers for storing per-user AO3 credentials.
// Uses AES-GCM via the Web Crypto API, which is available natively in the
// Cloudflare Workers/Pages runtime (no extra npm package needed).
//
// The encryption key comes from an environment variable (env.ENCRYPTION_KEY),
// set the same way you set AO3_USERNAME/AO3_PASSWORD:
//   wrangler pages secret put ENCRYPTION_KEY --project-name=fic-tracker
//
// Generate a good key value once with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// and paste that string in as the secret's value. Do this once and never
// change it — changing the key makes all previously-encrypted data
// undecryptable.

async function importKey(base64Key) {
  const rawKey = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// Encrypts a plaintext string. Returns a single string safe to store in
// Firestore: base64(iv) + ":" + base64(ciphertext)
export async function encryptString(plaintext, base64Key) {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertextBuffer)));

  return `${ivB64}:${ctB64}`;
}

// Reverses encryptString. Throws if the key is wrong or data was tampered with.
export async function decryptString(stored, base64Key) {
  const key = await importKey(base64Key);
  const [ivB64, ctB64] = stored.split(":");

  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));

  const plaintextBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(plaintextBuffer);
}
