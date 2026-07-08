# AO3 sign-in fallback for locked fics

This lets the AO3 import fetch details for works restricted to logged-in users, by signing in
as you when (and only when) a fetch comes back locked.

## Before you set this up

This stores your real AO3 username and password as a Cloudflare Pages environment variable
(secret). A few things worth knowing:

- It's only ever used **server-side**, inside the function — never sent to the browser, never
  visible in your site's code or network requests from the client.
- That said, AO3's own Privacy Policy is explicit that it doesn't cover what happens once you hand
  your login to a third-party tool — meaning this is on a trust basis with this code and with
  Cloudflare's secret storage, not something AO3 vouches for.
- It logs in fresh on each locked fic it encounters (simpler and more reliable than trying to
  keep a session alive between separate function invocations). This should be infrequent in
  normal use — it only triggers when a fetch comes back locked, not on every fetch.
- I couldn't test AO3's actual login form from where I built this, so treat it as a first attempt
  — if it doesn't work, send me what comes back and I'll adjust it.

## Setup

**Option A — CLI (recommended, prompts you so the value never ends up in shell history):**
```
wrangler pages secret put AO3_USERNAME --project-name=fic-tracker
wrangler pages secret put AO3_PASSWORD --project-name=fic-tracker
```

**Option B — Dashboard:**
1. Go to your project on the Cloudflare dashboard → **Settings → Environment variables**.
2. Add two variables: `AO3_USERNAME` (your AO3 login/email) and `AO3_PASSWORD`. Mark them as
   "Secret" type if given the option, so they're encrypted at rest.
3. Redeploy (`wrangler pages deploy dist --project-name=fic-tracker`) so the function picks them up.

## How to undo it

Remove the two variables (dashboard, or `wrangler pages secret delete AO3_USERNAME
--project-name=fic-tracker` / same for `AO3_PASSWORD`) and redeploy. Without them, locked fics
just behave as before — reported as locked, fill in manually.
