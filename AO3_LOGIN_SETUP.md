# AO3 sign-in fallback for locked fics

> **Current status: not active.** The server-side code for this is still in
> `functions/fetch-fic.js`, but the current app (`src/App.jsx`) calls `/fetch-fic` with only the
> work URL — it doesn't send your Firebase user ID or saved AO3 credentials, and the
> `AO3CredentialsSettings` component isn't shown in Settings. So locked/restricted works are
> always reported as locked, whatever secrets you set. Fill those in manually (or use the
> **Add to Library** bookmarklet while signed in to AO3 — it reads the page you're already viewing,
> so it works on locked fics too).
>
> The rest of this doc describes how the fallback works, for when it's wired back in.

## How it works

When a fetch of an AO3 work comes back locked, `fetch-fic` signs in to AO3 and retries — but only
if it can find credentials for whoever made the request. In priority order:

1. **The owner.** If the request's `userId` matches the `OWNER_UID` secret, it uses the
   `AO3_USERNAME` / `AO3_PASSWORD` secrets.
2. **Any other user** who saved their AO3 login in Settings. Their password is encrypted by
   `/encrypt-ao3-password` (AES-GCM, keyed by `ENCRYPTION_KEY`) and stored only in their own
   `users/{uid}/private/ao3Credentials` document. The app sends the username + ciphertext along
   with the fetch, and the function decrypts it server-side.
3. **Nobody** — the work is reported as locked.

It logs in fresh for each locked fic (simpler than keeping a session alive across stateless
function invocations). This only triggers on locked works, not every fetch.

Things worth knowing:

- Credentials are only ever used **server-side**, inside the function.
- AO3's Privacy Policy doesn't cover what happens once you hand your login to a third-party tool
  — this is on a trust basis with this code and Cloudflare's secret storage.

## Secrets

```
wrangler pages secret put AO3_USERNAME --project-name=fic-tracker
wrangler pages secret put AO3_PASSWORD --project-name=fic-tracker
wrangler pages secret put OWNER_UID --project-name=fic-tracker
wrangler pages secret put ENCRYPTION_KEY --project-name=fic-tracker
```

(Each command prompts for the value, so it never ends up in your shell history. You can also set
them in the dashboard: your project → **Settings → Variables and secrets**.)

- **`AO3_USERNAME` / `AO3_PASSWORD`** — your own AO3 login, used only for requests from you.
- **`OWNER_UID`** — your Firebase Auth UID (Firebase Console → Authentication → Users → your row).
  Without it, the owner path never matches.
- **`ENCRYPTION_KEY`** — needed for other users' saved logins. Generate once with:
  ```
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  **Never change this once anyone has saved credentials** — every saved password would become
  permanently undecryptable.

If you use a Preview environment too, set the same values there (append `--env preview`).
Redeploy afterwards so the functions pick them up.

For local testing with Docker, copy `.dev.vars.example` to `.dev.vars` and fill in
`AO3_USERNAME` / `AO3_PASSWORD` (add `OWNER_UID` / `ENCRYPTION_KEY` lines if needed).
`.dev.vars` is gitignored and dockerignored.

## How to undo it

Delete the secrets (dashboard, or `wrangler pages secret delete AO3_USERNAME
--project-name=fic-tracker`, and the same for the others) and redeploy.
