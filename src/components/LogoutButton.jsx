// src/components/LogoutButton.jsx
//
// Drop this into your Settings page/component wherever makes sense
// (e.g. near the bottom, or next to the AO3 credentials section).

import { signOutUser } from "../firebase"; // adjust path if this file isn't in src/components/

export default function LogoutButton() {
  async function handleLogout() {
    try {
      await signOutUser();
      // Your app likely already reacts to this via watchAuth()/onAuthStateChanged
      // wherever it's set up (e.g. in App.jsx) — no manual redirect should be needed.
    } catch (err) {
      console.error("Logout failed:", err);
    }
  }

  return (
    <button onClick={handleLogout} className="logout-button">
      Log out
    </button>
  );
}
