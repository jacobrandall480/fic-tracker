// src/components/AO3CredentialsSettings.jsx
//
// A small settings panel: lets a user save their AO3 login (encrypted
// server-side before storage) or remove it. Uses your existing Firebase
// client SDK — no new dependencies.
//
// Drop this into your settings page / a modal, wherever makes sense in
// your existing UI.

import { useState, useEffect } from "react";
import { doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import { db, auth } from "../firebase"; // adjust path if this file isn't in src/components/

export default function AO3CredentialsSettings() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [status, setStatus] = useState("");

  const credsDocRef = () => doc(db, "users", auth.currentUser.uid, "private", "ao3Credentials");

  useEffect(() => {
    async function checkExisting() {
      if (!auth.currentUser) return;
      const snap = await getDoc(credsDocRef());
      if (snap.exists()) {
        setHasSaved(true);
        setUsername(snap.data().ao3Username || "");
      }
    }
    checkExisting();
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setStatus("Saving...");

    try {
      // 1. Encrypt the password server-side (plaintext never touches Firestore)
      const res = await fetch("/encrypt-ao3-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) throw new Error("Encryption request failed");
      const { encrypted } = await res.json();

      // 2. Write username + ciphertext to this user's own private doc.
      //    Firestore rules already restrict this path to the signed-in
      //    user themselves.
      await setDoc(credsDocRef(), {
        ao3Username: username,
        ao3PasswordEnc: encrypted,
        updatedAt: new Date().toISOString(),
      });

      setPassword(""); // never keep plaintext around client-side either
      setHasSaved(true);
      setStatus("Saved. You won't need to re-enter this for locked fics.");
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  async function handleRemove() {
    setStatus("Removing...");
    try {
      await deleteDoc(credsDocRef());
      setHasSaved(false);
      setUsername("");
      setPassword("");
      setStatus("Removed.");
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  return (
    <div className="ao3-credentials-settings">
      <h3>AO3 Login (optional)</h3>
      <p>
        Only needed to fetch details for locked/restricted works. Your
        password is encrypted before it's saved, and only used to look up
        fics on your behalf.
      </p>

      {hasSaved ? (
        <div>
          <p>Saved for: <strong>{username}</strong></p>
          <button onClick={handleRemove}>Remove saved login</button>
        </div>
      ) : (
        <form onSubmit={handleSave}>
          <input
            type="text"
            placeholder="AO3 username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            type="password"
            placeholder="AO3 password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button type="submit">Save</button>
        </form>
      )}

      {status && <p className="status">{status}</p>}
    </div>
  );
}
