# Fic Tracker

A personal AO3 reading tracker: word counts, reading progress, series, collections, stats, and
one-click import straight from AO3 — no manual data entry. Built on React + Firebase, deployed on
Cloudflare Pages.

- **Live data, synced everywhere** — sign in with the same email/password on any device and
  everything syncs in real time.
- **Reading statuses**: Unread, Currently Reading, Completed, On Hold, Abandoned. For a WIP you're
  up to date on, the card's **Caught up** button marks it Completed with your progress set to the
  latest posted chapter; if new chapters show up the next time the fic's stats are refreshed, it
  flips back to Currently Reading on its own.
- **Fic status** (Complete / WIP / Hiatus) — a work with an unknown chapter total (`N/?`) is
  imported as a WIP.
- **Series & collections**, with automatic series linking on import, plus a **Recs** tab and a
  **Favorite authors** list.
- **Duplicate detection** on every import path (matches by AO3 work ID first, then exact link,
  then title + author). When something you're adding is already in your library, you're offered a
  stats refresh instead of a re-add.
- **30-day Trash** for deletions — restore or delete forever from the Trash icon in the nav (only
  shown when Trash isn't empty).
- **Stats**: words read, top fandoms/ships/tags, and WIPs to check on.
- **Expandable summaries** on each card.
- **Locked/restricted fics** are reported as locked — fill those in manually. (The server-side
  functions still contain an AO3 sign-in fallback, but the current app doesn't send credentials to
  it — see [AO3_LOGIN_SETUP.md](./AO3_LOGIN_SETUP.md).)

## Using it on your computer

### Adding fics from AO3

Open **Settings** (gear icon, top right). There are two buttons to drag to your bookmarks bar:

- **Add to Library** — on any AO3 **work page**, click it: it reads the title, fandoms, rating,
  word count, dates, chapters, series, summary, etc. straight off the page (no extra request to
  AO3) and opens the app with the Add form pre-filled. Review and hit Save. If it can't read the
  page, it falls back to having the server fetch the work instead.
- **Add Page to Library** — same idea, but for a whole **series page, collection, search results,
  or tag page** — anywhere AO3 shows a list of work blurbs. You get a review panel listing every
  work on that page, with checkboxes to pick which to add; duplicates are auto-detected and offered
  a stats refresh instead of a re-add. Paginated pages only import the current page — click
  through page by page for more.

**Drag these buttons to your bookmarks bar — don't click them on the Fic Tracker site itself**;
they only do something on an actual AO3 page.

You can also click **Add fic** and paste an AO3 link to have it fetched server-side, or use
**Add from AO3 series** on the Series tab to pull in every work in a series by its link.

### Other ways to get data in

- **Import CSV** (Settings) — needs a `link` (or `url`) column; AO3 work/series/collection links
  all work. Title, author, fandoms, relationships, characters, tags, warnings, rating, word count,
  chapters, summary and series columns are used when present, and an optional `source`/`shelf`
  column becomes a Collection. [`ao3_scraper_rich.js`](./ao3_scraper_rich.js) is a helper script
  that produces a CSV in this shape from AO3 listing pages.
- **Import JSON** (Settings) — Fic Tracker's own backup format. Choose **Merge** (adds new fics,
  optionally refreshes AO3 stats on matching ones, never removes anything) or **Replace
  everything** (makes your library match the file; anything not in it goes to Trash).
- **Export JSON** (Settings) — full backup of your library plus lists (series, collections,
  favorite authors), any time.

**Clear all data** (Settings) moves every fic to Trash and permanently deletes your saved
collections/series/authors — export a backup first.

## Using it on iPhone

### 1. Install it as an app

Open the site in **Safari** (must be Safari, not Chrome) → **Share** → **Add to Home Screen**.
You'll get a proper icon that launches full-screen with no browser chrome.

### 2. Set up the AO3 shortcuts (one-time, ~5 minutes each)

Regular bookmarklets don't work well on iOS Safari, so importing instead runs through the
**Shortcuts** app, using its "Run JavaScript on Webpage" action — same logic as the desktop
bookmarklets, just triggered from the Share Sheet instead of a bookmarks bar.

Two scripts in this repo are used for this:
- [`ios-shortcut-add-fic.js`](./ios-shortcut-add-fic.js) — single work page
- [`ios-shortcut-add-bulk.js`](./ios-shortcut-add-bulk.js) — series/collection/search-results pages

> [`ios-shortcut-update-progress.js`](./ios-shortcut-update-progress.js) is also in the repo, but
> the current app doesn't handle the `?updateProgress=` link it produces, so it won't do anything
> yet. Skip it for now.

**Both scripts have your site's URL hardcoded near the top** (`var ORIGIN = 'https://fic-tracker.pages.dev';`)
— edit that line first if your deployment uses a different URL.

**Build the shortcut:**

1. Open the **Shortcuts** app → **+** (new shortcut).
2. Add action **Run JavaScript on Webpage** → paste in the full contents of the script file.
3. Add action **URL** (search for "URL" — it's its own action, distinct from "Open URLs") → set
   its input to the **JavaScript Result** (the output of the step above).
   > This step matters more than it looks: feeding a long string straight into "Open URLs" is
   > unreliable in Shortcuts and can silently open a blank/broken link. Passing it through a
   > dedicated **URL**-typed action first fixes that.
4. Add action **Open URLs** → set its input to the output of the **URL** action from step 3 (not
   directly to the JavaScript Result).
5. Rename the shortcut (tap the name/settings at top): **"Add to Fic Tracker"**
   (**"Bulk Add to Fic Tracker"** for the bulk script).
6. Tap the **ⓘ** settings icon → enable **"Show in Share Sheet"** → under **Share Sheet Types**,
   restrict to **Safari web pages**.

Repeat for the second script.

**Using it:** on an AO3 work page (or a series/collection page) in Safari → **Share** → tap the
matching shortcut. It reads the page and opens the app with the Add form or bulk-import review
panel pre-filled — review and Save.

**Testing/debugging a shortcut:** "Run JavaScript on Webpage" only does anything when triggered
from the Share Sheet on a real webpage — the ▶️ Play button in the Shortcuts editor won't run it
properly. To inspect exactly what the script produced, add a **Quick Look** action between the
JavaScript step and the URL step (temporarily) — it'll show the raw encoded text so you can check
it's non-empty before it gets opened.

**Known limitation:** iOS won't hand off a regular link to an installed Home Screen app — only
true native apps can register for that (via Apple's Universal Links, which requires owning the
linked domain). So a shortcut opens the app in **Safari**, not your Home Screen icon, even though
it's the same account and the same data. Cosmetic only — switch to the Home Screen app afterward
and the new fic will already be there.

## Deploying / self-hosting

### One-time setup

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up — no credit card needed.
2. Install the CLI: `npm install -g wrangler`
3. `wrangler login` (opens your browser to authorize).
4. `npm install` in this project folder.
5. Using your own Firebase project instead of the one in `src/firebase.js`? Follow
   [FIREBASE_SETUP.md](./FIREBASE_SETUP.md) first.

### Deploy

```
npm run deploy
```

That's shorthand for:

```
npm run build
wrangler pages deploy dist --project-name=fic-tracker --branch=production
```

Run it **from the project root** (`functions/` and `dist/` need to be siblings) — Wrangler picks
up `functions/` automatically. The first run creates the Pages project; every run after redeploys
to it. It prints your live URL (`https://fic-tracker-xxx.pages.dev` or similar).

**The `--branch=production` flag matters** if this project isn't connected to a GitHub repo on
Cloudflare's side (Pages → project → Settings → Build → "Git repository" shows "Connect" rather
than a linked repo). Without it, Wrangler tags the deploy with whatever your local git branch
happens to be, which can land it as a Preview deployment instead of Production — meaning your
main domain (`fic-tracker.pages.dev`) silently stops updating even though the deploy itself
succeeds. If pages ever seem stale after a deploy, check **Deployments** → **Production** to
confirm the domain points at your latest deploy.

If you're not using the default `fic-tracker.pages.dev` URL, update `ORIGIN` in
`ios-shortcut-add-fic.js` and `ios-shortcut-add-bulk.js` to match. (The desktop bookmarklets pick
up your site's URL automatically.)

The app is a PWA with a service worker (`vite-plugin-pwa`, auto-update). If an installed copy keeps
showing an old version, bump the `revision` in `vite.config.js` and redeploy.

### Secrets

None are required for the app to work. The only secrets the functions read relate to the AO3
sign-in fallback, which the current app doesn't use — see [AO3_LOGIN_SETUP.md](./AO3_LOGIN_SETUP.md)
for what they are if you want them in place.

### Firebase

`src/firebase.js` ships with the project's public web config already in the code — that's
expected; Firebase access is controlled by security rules, not by hiding this config. Auth/sync
work the same in any environment (local dev, Docker, production) without extra setup.

### Local dev / Docker

```
docker build -t fic-tracker .
docker run -p 8788:8788 fic-tracker
```

Then open http://localhost:8788 — the app and the `/fetch-fic`, `/fetch-series`,
`/fetch-collection-bookmarks` and `/encrypt-ao3-password` functions all run inside the container
via `wrangler pages dev`, same as on Cloudflare.

Or with docker-compose:

```
cp .dev.vars.example .dev.vars   # fill in AO3_USERNAME/AO3_PASSWORD, or leave blank
docker compose up --build
```

`npm run dev` also works for frontend-only work (Vite dev server), but the `/fetch-*` functions
won't be available there — use Docker or `wrangler pages dev` for those.

## Repo structure

```
src/main.jsx                         — React entry point
src/App.jsx                          — the whole app (single-file React component)
src/firebase.js                      — Firebase config + all read/write helpers
src/components/AO3CredentialsSettings.jsx — per-user AO3 login UI (not currently used by App.jsx)
functions/fetch-fic.js               — server-side single-work fetch (Cloudflare Pages Function)
functions/fetch-series.js            — server-side series fetch
functions/fetch-collection-bookmarks.js — server-side collection fetch
functions/encrypt-ao3-password.js    — encrypts a password before it's saved to Firestore
functions/lib/crypto.js              — AES-GCM encrypt/decrypt helpers, keyed by ENCRYPTION_KEY
public/manifest.webmanifest, icon-192.png, icon-512.png — PWA manifest + icons
vite.config.js                       — Vite + PWA (service worker) config
ios-shortcut-add-fic.js              — paste into the iOS "Add to Fic Tracker" shortcut
ios-shortcut-add-bulk.js             — paste into the iOS "Bulk Add to Fic Tracker" shortcut
ios-shortcut-update-progress.js      — progress-update shortcut (not handled by the current app)
ao3_scraper_rich.js                  — helper that scrapes AO3 listing pages into an importable CSV
Dockerfile, docker-compose.yml, .dev.vars.example — local dev / self-hosting
FIREBASE_SETUP.md                    — setting up your own Firebase project
AO3_LOGIN_SETUP.md                   — the (currently unused) AO3 sign-in fallback
```
