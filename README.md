# Fic Tracker

A personal AO3 reading tracker: word counts, reading progress, series, collections, stats, and
one-click import straight from AO3 — no manual data entry. Built on React + Firebase, deployed on
Cloudflare Pages.

- **Live data, synced everywhere** — sign in with the same account on any device, everything syncs
  in real time.
- **Reading statuses**: Unread, Currently Reading, Caught Up, Completed, On Hold, Abandoned.
  "Caught Up" is specifically for a WIP you're fully read up on — it won't clutter your Currently
  Reading list, but it's still easy to pull up and check for updates later.
- **Series & collections**, with automatic series-membership linking on import.
- **Duplicate detection** on import (matches by AO3 work ID first, falling back to title+author),
  plus a "Possible duplicates" finder for anything that slipped through before.
- **Undo** — every status change, edit, and import is reversible from a Recent Changes panel, on
  top of a 30-day Trash for deletions.
- **Stats**: words read, top fandoms/ships/tags, open WIPs to check on.

## Using it on your computer

### Adding fics from AO3

Open **Settings** (gear icon, top right) — there are three buttons to drag to your bookmarks bar:

- **Add to Library** — go to Settings, drag the button to your bookmarks bar. On any AO3 **work
  page**, click it: it reads the title, fandoms, rating, word count, dates, chapters, series, etc.
  straight off the page (no extra request to AO3) and opens the app with the Add form pre-filled.
  Review and hit Save.
- **Add Page to Library** — same idea, but for a whole **series page, collection, search results,
  or tag page** — anywhere AO3 shows a list of work blurbs. Click it and you get a review panel
  listing every work on that page, with checkboxes to pick which to add, and duplicates
  auto-detected and offered a stats refresh instead of a re-add. Paginated pages only import the
  current page — click through page by page for more.
- **Update Progress** — drag it too, then click it while you're actually **reading a chapter** on
  AO3 (chapter-by-chapter view — on AO3, Preferences → uncheck "Show entire work at once"). It
  matches the fic by AO3 link, sets your reading progress to that chapter, and saves the exact
  chapter URL so the fic's title in your library opens straight back to where you left off next
  time. Only updates fics already in your library — add the fic first if it isn't there yet.
  - Marking a fic **Completed** resets that saved link back to chapter 1 for next time; marking it
    **Caught Up** leaves it exactly where it is, since the fic itself isn't done yet.
  - If it can't tell which chapter you're on (e.g. you're viewing the "entire work" on one page,
    or AO3's markup trips up detection), it still opens the app and saves the chapter link, but
    leaves your chapter *count* untouched rather than guessing — you'll get a heads-up toast so you
    can double check it.

**Drag these buttons to your bookmarks bar — don't click them on the Fic Tracker site itself**,
they only do something on an actual AO3 page.

### Other ways to get data in

- **Import CSV** (Settings) — for AO3's own export format (bookmarks/marked-for-later CSV
  exports) or Goodreads-style shelf exports.
- **Import JSON** (Settings) — Fic Tracker's own backup format; also merges/updates existing
  entries by matching AO3 link or title+author, same duplicate-safe logic as everything else.
- **Export JSON** (Settings) — full backup of your library + lists (series/collections),
  any time.

### Duplicates & undo

If two entries turn out to be the same fic, open the **duplicates icon** in the nav (only shows up
when there's something to review) — pick which copy to keep, and its series links, collections,
and tags absorb the other's before it's moved to Trash.

Made a mistake — wrong status, bad edit, bad import? Click **Undo** on the toast that pops up
after any change, or open the **Recent Changes** icon in the nav for a list of the last 20 actions
with individual Undo buttons.

## Using it on iPhone

### 1. Install it as an app

Open the site in **Safari** (must be Safari, not Chrome) → **Share** → **Add to Home Screen**.
You'll get a proper icon that launches full-screen with no browser chrome.

### 2. Set up the AO3 shortcuts (one-time, ~5 minutes each)

Regular bookmarklets don't work well on iOS Safari, so importing and progress updates instead run
through the **Shortcuts** app, using its "Run JavaScript on Webpage" action — same logic as the
desktop bookmarklets, just triggered from the Share Sheet instead of a bookmarks bar.

Three scripts live in this repo for this:
- [`ios-shortcut-add-fic.js`](./ios-shortcut-add-fic.js) — single work page
- [`ios-shortcut-add-bulk.js`](./ios-shortcut-add-bulk.js) — series/collection/search-results pages
- [`ios-shortcut-update-progress.js`](./ios-shortcut-update-progress.js) — while reading a chapter,
  updates your progress and saves the chapter link (same logic as the desktop "Update Progress"
  bookmarklet — see above for what it does and its fallback behavior when it can't detect a chapter
  number)

**All three scripts have your site's URL hardcoded near the top** (`var ORIGIN = 'https://fic-tracker.pages.dev';`)
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
   (**"Bulk Add to Fic Tracker"** for the bulk script, **"Update Reading Progress"** for the
   progress script).
6. Tap the **ⓘ** settings icon → enable **"Show in Share Sheet"** → under **Share Sheet Types**,
   restrict to **Safari web pages**.

Repeat the whole thing for each script to get all three shortcuts.

**Using it:** on an AO3 work page (or a chapter you're reading, or a series/collection page) in
Safari → **Share** → tap the matching shortcut. It scrapes/reads the page and opens the right
screen in the app pre-filled — review and Save (import), or it just applies (progress update, no
review step needed).

**Testing/debugging a shortcut:** "Run JavaScript on Webpage" only does anything when triggered
from the Share Sheet on a real webpage — the ▶️ Play button in the Shortcuts editor won't run it
properly. To inspect exactly what the script produced without committing to opening it, add a
**Quick Look** action between the JavaScript step and the URL step (temporarily) — it'll pop up
the raw scraped/encoded text so you can check it's non-empty before it gets opened.

**Known limitation:** iOS won't hand off a regular link to an installed Home Screen app — only
true native apps can register for that (this needs Apple's Universal Links, which requires owning
the linked domain; archiveofourown.org isn't yours to configure that way). So tapping a shortcut
opens the app in **Safari**, not your installed app icon, even though it's the same account and
the same data. Cosmetic only — switch to the Home Screen app afterward and the update will already
be there.

## Deploying / self-hosting

### One-time setup

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up — no credit card needed.
2. Install the CLI: `npm install -g wrangler`
3. `wrangler login` (opens your browser to authorize).
4. `npm install` in this project folder.

### Deploy

```
npm run build
wrangler pages deploy dist --project-name=fic-tracker
```

Run this **from the project root** (`functions/` and `dist/` need to be siblings) — Wrangler picks
up `functions/` automatically. First run creates the Pages project; every run after redeploys to
it. It prints your live URL (`https://fic-tracker-xxx.pages.dev` or similar).

If you're not using the default `fic-tracker.pages.dev` URL, update `ORIGIN` in
`ios-shortcut-add-fic.js`, `ios-shortcut-add-bulk.js`, and `ios-shortcut-update-progress.js` to
match.

### AO3 login env vars (optional, for locked/restricted fics)

```
wrangler pages secret put AO3_USERNAME --project-name=fic-tracker
wrangler pages secret put AO3_PASSWORD --project-name=fic-tracker
```

Or via the dashboard: your project → **Settings → Environment variables**.

### Firebase

`src/firebase.js` ships with the project's public web config already in the code — that's
expected, Firebase access is controlled by security rules, not by hiding this config. Auth/sync
work the same in any environment (local dev, Docker, production) without extra setup.

### Local dev / Docker

```
docker build -t fic-tracker .
docker run -p 8788:8788 fic-tracker
```

Then open http://localhost:8788 — the app and the `/fetch-fic`, `/fetch-series`,
`/fetch-collection-bookmarks` functions all run from inside the container, same as Wrangler on
Cloudflare.

Or with docker-compose (also wires up the optional AO3 login fallback):

```
cp .dev.vars.example .dev.vars   # fill in AO3_USERNAME/AO3_PASSWORD, or leave blank
docker compose up --build
```

## Repo structure

```
src/App.jsx                          — the whole app (single-file React component)
src/firebase.js                      — Firebase config + all read/write helpers
functions/fetch-fic.js               — server-side single-work fetch (Cloudflare Pages Function)
functions/fetch-series.js            — server-side series fetch
functions/fetch-collection-bookmarks.js
public/manifest.webmanifest          — PWA manifest
public/apple-touch-icon.png, icon-*.png
ios-shortcut-add-fic.js              — paste into the iOS "Add to Fic Tracker" shortcut
ios-shortcut-add-bulk.js             — paste into the iOS "Bulk Add to Fic Tracker" shortcut
ios-shortcut-update-progress.js      — paste into the iOS "Update Reading Progress" shortcut
```
