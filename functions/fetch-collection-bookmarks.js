// Fetches an AO3 collection's bookmarks page server-side (with pagination), and pulls out
// each bookmarked work's URL plus, where findable, the username of whoever bookmarked it.
// This part of AO3's markup is less consistently documented than work/series pages, so the
// bookmarker-name detection is a best-effort heuristic — it may need tweaking against a real page.
//
// Ported from a Netlify Function to Cloudflare Pages Functions' onRequestGet(context) convention.
// Bonus: Cloudflare Workers don't impose a hard wall-clock execution limit on HTTP-triggered
// functions the way Netlify did (the CPU-time limit only counts active computation, not time
// spent waiting on fetch() — which is most of what this function does) — so the multi-page
// crash issue we kept hitting on Netlify is much less likely here. Keeping the same
// timeouts/deadline logic anyway as a sensible safety net.

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  ).trim();
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const MAX_PAGES = 10;
const PER_REQUEST_TIMEOUT_MS = 7000;
const OVERALL_DEADLINE_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PER_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Detects AO3's overload responses — these vary: sometimes a full "Page Responding Too
// Slowly" HTML page, sometimes just a bare few words like "Retry later" (lowercase, no full
// page at all). Checking case-insensitively for either phrase, plus treating any suspiciously
// short response as overload too, since a real AO3 page is never this small.
function isOverloadResponse(html) {
  return /page responding too slowly|retry later|shields are up/i.test(html) || html.length < 200;
}

async function fetchPageWithRetry(pageUrl, deadline) {
  let html = null;
  for (let attempt = 0; attempt <= 1; attempt++) {
    if (Date.now() > deadline) return { html, throttled: true, outOfTime: true };
    if (attempt > 0) await sleep(1200);
    try {
      const resp = await fetchWithTimeout(pageUrl, { headers: BROWSER_HEADERS });
      html = await resp.text();
    } catch {
      continue; // timed out or network error — retry if an attempt remains
    }
    if (!isOverloadResponse(html)) {
      return { html, throttled: false };
    }
  }
  return { html, throttled: true };
}

export async function onRequestGet(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const url = reqUrl.searchParams.get("url") || "";
  const debug = reqUrl.searchParams.get("debug") === "1";
  const startPage = Math.max(1, parseInt(reqUrl.searchParams.get("startPage") || "1", 10) || 1);
  const providedName = reqUrl.searchParams.get("collectionName");
  const match = url.match(/^https:\/\/(www\.|m\.)?archiveofourown\.org\/collections\/([^/?]+)\/bookmarks/);

  if (!match) {
    return jsonResponse({ error: "Please paste a link to an AO3 collection's bookmarks page (.../collections/NAME/bookmarks)." }, 400);
  }

  const slug = match[2];
  let collectionName = providedName || null;
  const items = [];
  let firstPageHtml = "";
  let pagesFetched = 0;
  let stoppedBecause = null;
  let lastGoodPage = startPage - 1;
  const deadline = Date.now() + OVERALL_DEADLINE_MS;

  for (let page = startPage; page <= MAX_PAGES; page++) {
    if (Date.now() > deadline) {
      stoppedBecause = "time-budget-exceeded";
      break;
    }
    if (page > startPage) await sleep(500); // pace requests — AO3 rate-limits rapid sequential hits

    const pageUrl = `https://archiveofourown.org/collections/${slug}/bookmarks?page=${page}&view_adult=true`;
    let html;
    let throttled = false;
    let outOfTime = false;
    try {
      const result = await fetchPageWithRetry(pageUrl, deadline);
      html = result.html;
      throttled = result.throttled;
      outOfTime = !!result.outOfTime;
      pagesFetched++;
    } catch {
      stoppedBecause = "fetch-error";
      break;
    }
    if (!html) {
      stoppedBecause = "fetch-error";
      break;
    }
    if (throttled) {
      stoppedBecause = outOfTime ? "time-budget-exceeded" : "ao3-overloaded";
      if (page === startPage) firstPageHtml = html;
      break;
    }
    if (page === startPage) firstPageHtml = html;

    if (!collectionName) {
      const titleMatch = html.match(/<title>([^<]*)<\/title>/);
      if (titleMatch) {
        collectionName = stripTags(titleMatch[1])
          .split(" | Archive of Our Own")[0]
          .replace(/\s*-\s*Bookmarks\s*(\(\d+\))?\s*$/i, "")
          .trim();
      }
      if (!collectionName) collectionName = slug;
    }

    // Confirmed real markup: <li id="bookmark_X" class="bookmark blurb group work-Y user-Z" ...>
    let blocks = html.split('<li id="bookmark_').slice(1);
    if (blocks.length === 0) {
      // Fallback in case AO3 changes this — try anchoring on the heading instead.
      blocks = html.split('<h4 class="heading">').slice(1);
    }
    if (blocks.length === 0) {
      stoppedBecause = page === startPage ? "no-blocks-on-first-page" : "no-blocks-on-later-page";
      break;
    }

    for (const block of blocks) {
      const headMatch = block.match(/^\d+"\s+class="bookmark blurb group work-(\d+)/);
      const workMatch = headMatch || block.match(/<a href="[^"]*\/works\/(\d+)"[^>]*>[^<]*<\/a>/);
      if (!workMatch) continue; // likely an external (non-AO3) bookmark — skip
      const workId = workMatch[1];

      const authorMatch = block.match(/rel="author"[^>]*>([^<]+)</);
      const author = authorMatch ? decodeEntities(authorMatch[1]).trim() : null;

      const userRe = /\/users\/([A-Za-z0-9_-]+)/g;
      const seenUsers = [];
      let um;
      while ((um = userRe.exec(block))) {
        if (!seenUsers.includes(um[1]) && um[1] !== author) seenUsers.push(um[1]);
      }
      const bookmarker = seenUsers.length > 0 ? seenUsers[seenUsers.length - 1] : null;

      if (!items.some((it) => it.workId === workId)) {
        items.push({ workId, bookmarker });
      }
    }

    lastGoodPage = page;

    const hasNext = html.includes('<li class="next">');
    if (!hasNext) {
      stoppedBecause = "no-next-link";
      break;
    }
    if (page === MAX_PAGES) stoppedBecause = "hit-max-pages";
  }

  // If we stopped without reaching a clean "no more pages" ending, the next resume attempt
  // should pick up right after the last page we actually finished.
  const finished = stoppedBecause === "no-next-link";
  const nextPage = finished ? null : lastGoodPage + 1;

  if (items.length === 0) {
    if (debug) {
      const worksLinkCount = (firstPageHtml.match(/\/works\/\d+/g) || []).length;
      const firstWorksIdx = firstPageHtml.search(/\/works\/\d+/);
      return jsonResponse({
        debug: true,
        collectionName,
        pagesFetched,
        stoppedBecause,
        nextPage,
        htmlLength: firstPageHtml.length,
        containsBookmarkLi: firstPageHtml.includes('<li id="bookmark_'),
        worksLinkCount,
        excerpt:
          firstWorksIdx === -1
            ? firstPageHtml.slice(0, 2000)
            : firstPageHtml.slice(Math.max(0, firstWorksIdx - 500), firstWorksIdx + 3000),
      });
    }
    return jsonResponse({
      locked: true,
      collectionName,
      nextPage,
      error:
        stoppedBecause === "ao3-overloaded"
          ? "AO3's server reported it was overloaded ('Page Responding Too Slowly') and didn't recover after a few retries. This is on AO3's end, not a parsing issue — wait a bit and try again."
          : stoppedBecause === "time-budget-exceeded"
          ? "AO3 was responding too slowly to finish within the time limit. Try again — partial results may work better on a retry."
          : "Found the collection, but no bookmarked AO3 works in it — it may be restricted or empty.",
    });
  }

  return jsonResponse({
    collectionName,
    items: items.map((it) => ({
      url: `https://archiveofourown.org/works/${it.workId}`,
      bookmarker: it.bookmarker,
    })),
    pagesFetched,
    stoppedBecause,
    nextPage,
    locked: false,
  });
}
