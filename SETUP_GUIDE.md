# Per-user AO3 credentials — setup guide

## What this does
- **You**: never prompted, always uses your existing `AO3_USERNAME`/`AO3_PASSWORD` env vars automatically.
- **Everyone else**: prompted once for their own AO3 login, which is encrypted and saved so they aren't prompted again. Nobody but you ever uses your account.

## Files in this bundle
```
functions/lib/crypto.js              — encrypt/decrypt helper (AES-GCM)
functions/encrypt-ao3-password.js    — new endpoint: encrypts a password, returns ciphertext
functions/fetch-fic.js               — updated: resolves whose credentials to use per-request
firestore-rules-addition.txt         — explains your existing rules already cover this (no change needed)
src/components/AO3CredentialsSettings.jsx — UI for users to save/remove their AO3 login
```

## Setup steps

### 1. Generate an encryption key (one time, ever)
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
Copy the output string.

### 2. Set two new Cloudflare secrets
```bash
wrangler pages secret put ENCRYPTION_KEY --project-name=fic-tracker
# paste the string from step 1 when prompted

wrangler pages secret put OWNER_UID --project-name=fic-tracker
# paste YOUR Firebase Auth UID — find it at:
# Firebase Console -> Authentication -> Users -> your row -> "User UID" column
```

**Important:** once `ENCRYPTION_KEY` is set, do not change it later — doing so makes every previously-saved credential undecryptable (users would need to re-enter and re-save).

### 3. Drop the new/updated files into your project
- Copy `functions/lib/crypto.js` and `functions/encrypt-ao3-password.js` in as-is.
- Merge `functions/fetch-fic.js` into your existing fetch-fic function — the important part is: stop reading `env.AO3_USERNAME`/`env.AO3_PASSWORD` directly inside your scraping logic, and instead pass in the `username`/`password` resolved at the top of the file (see the comments in that file for exactly where to wire it in — I left your actual scraping logic as a placeholder since I don't have `ao3_scraper_rich.js` in front of me).
- Copy `src/components/AO3CredentialsSettings.jsx` in, adjust the `../firebase` import path to match wherever your `db`/`auth` exports actually live, and add it to your settings page/modal.

### 4. Firestore rules
No change needed — your existing `{document=**}` wildcard rule already protects this new path. See `firestore-rules-addition.txt` if you want to double check or add an explicit rule for readability.

### 5. Update the fetch-fic call site in your frontend
Wherever your app currently calls `/fetch-fic` for a locked/restricted fic, it needs to also send along the current user's saved credentials (if any) so the function can use them:

```js
// before calling /fetch-fic for a fic that might be locked:
const credsSnap = await getDoc(doc(db, "users", auth.currentUser.uid, "private", "ao3Credentials"));
const creds = credsSnap.exists() ? credsSnap.data() : null;

const res = await fetch("/fetch-fic", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ficUrl,
    userId: auth.currentUser.uid,
    ao3Username: creds?.ao3Username,
    ao3PasswordEnc: creds?.ao3PasswordEnc,
  }),
});
```

If `creds` is null (user hasn't saved anything, and isn't you) and the fic turns out to be locked, `fetch-fic.js` will fail gracefully — have your UI catch that and show the `AO3CredentialsSettings` prompt at that point.

## Security model, plainly stated
- Plaintext AO3 passwords exist only in two places, both transient: (1) briefly in the browser while the user is typing, sent once over HTTPS to your Function; (2) briefly in your Cloudflare Function's memory during encryption or during an AO3 login request. Never written to disk or logs in plaintext.
- What's actually stored in Firestore is ciphertext — unreadable without `ENCRYPTION_KEY`, which lives only as a Cloudflare secret, never in the frontend or the database.
- Firestore security rules ensure each user's saved credential doc is only reachable by that same signed-in user through your app.
- Your own AO3 credentials stay exactly where they've always been (Cloudflare env vars) and are never read from or written to Firestore at all.
