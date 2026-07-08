// functions/encrypt-ao3-password.js
//
// The ONLY job of this function: take a plaintext password, encrypt it
// with the server-side key, and return the ciphertext. It never touches
// Firestore itself — your frontend already has an authenticated Firestore
// connection via the Firebase client SDK, so it writes the ciphertext to
// the user's own doc directly (protected by your existing security rules).
// This keeps things simple: no service account, no Admin SDK, one less
// thing that can go wrong.
//
// POST body: { password: "plaintext ao3 password" }
// Response:  { encrypted: "ivBase64:ciphertextBase64" }

import { encryptString } from "./lib/crypto.js";

export async function onRequestPost({ request, env }) {
  try {
    const { password } = await request.json();

    if (!password) {
      return new Response(JSON.stringify({ error: "Missing password" }), { status: 400 });
    }

    const encrypted = await encryptString(password, env.ENCRYPTION_KEY);

    return new Response(JSON.stringify({ encrypted }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
