// Fetches an AO3 series page server-side and pulls out the series name, description,
// and the ordered list of work URLs in it. The client then fetches each work's full
// details individually via fetch-fic.js.
//
// AO3 paginates series pages once there are enough works in them (same as collection
// bookmark pages) — this walks every page rather than assuming everything fits on one.

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
const PER_REQUEST_TIMEOUT_MS = 8000;
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

// AO3's overload responses vary — sometimes a full "Page Responding Too Slowly" HTML page,
// sometimes a bare "Retry later", sometimes a "Shields are up!" anti-abuse page. Checking
// case-insensitively for any of these, plus treating any suspiciously short response as
// overload too, since a real AO3 page is never this small.
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
      continue;
    }
    if (!isOverloadResponse(html)) return { html, throttled: false };
  }
  return { html, throttled: true };
}

export async function onRequestGet(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const url = reqUrl.searchParams.get("url") || "";
  const debug = reqUrl.searchParams.get("debug") === "1";
  const seriesMatch = url.match(/^https:\/\/(www\.|m\.)?archiveofourown\.org\/series\/(\d+)/);

  if (!seriesMatch) {
    return jsonResponse({ error: "Please paste a link to an AO3 series page (archiveofourown.org/series/...)." }, 400);
  }

  const seriesId = seriesMatch[2];
  let seriesName = null;
  let description = null;
  let seriesCompleted = null;
  const workIds = [];
  let pagesFetched = 0;
  let stoppedBecause = null;
  let firstPageHtml = "";
  const deadline = Date.now() + OVERALL_DEADLINE_MS;

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() > deadline) {
      stoppedBecause = "time-budget-exceeded";
      break;
    }
    if (page > 1) await sleep(500); // pace requests — AO3 rate-limits rapid sequential hits

    const pageUrl = `https://archiveofourown.org/series/${seriesId}?page=${page}&view_adult=true`;
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
      if (page === 1) firstPageHtml = html;
      break;
    }
    if (page === 1) firstPageHtml = html;

    if (page === 1) {
      const titleMatch = html.match(/<h2 class="heading">\s*([\s\S]*?)\s*<\/h2>/);
      if (!titleMatch) {
        if (debug) {
          return jsonResponse({ debug: true, stage: "title-not-found", htmlLength: html.length, excerpt: html.slice(0, 3000) });
        }
        return jsonResponse({
          locked: true,
          error: "Couldn't read this series — it may be restricted to logged-in users.",
        });
      }
      seriesName = stripTags(titleMatch[1]);

      const descMatch = html.match(/<blockquote class="userstuff">([\s\S]*?)<\/blockquote>/);
      description = descMatch ? stripTags(descMatch[1]) : null;

      // AO3 shows the series' own completion status as a plain "Complete: Yes/No" stat —
      // distinct from any individual work's status — right in the series metadata block.
      const completeMatch = html.match(/<dt>\s*Complete:\s*<\/dt>\s*<dd>\s*(Yes|No)\s*<\/dd>/i);
      seriesCompleted = completeMatch ? completeMatch[1].toLowerCase() === "yes" : null;
    }

    const re = /<h4 class="heading">[\s\S]*?<a href="\/works\/(\d+)"/g;
    let m;
    while ((m = re.exec(html))) {
      if (!workIds.includes(m[1])) workIds.push(m[1]);
    }

    const hasNext = html.includes('<li class="next">');
    if (!hasNext) {
      stoppedBecause = "no-next-link";
      break;
    }
    if (page === MAX_PAGES) stoppedBecause = "hit-max-pages";
  }

  if (workIds.length === 0) {
    if (debug) {
      const worksLinkCount = (firstPageHtml.match(/\/works\/\d+/g) || []).length;
      const firstWorksIdx = firstPageHtml.search(/\/works\/\d+/);
      const firstH4Idx = firstPageHtml.search(/<h4[^>]*>/);
      return jsonResponse({
        debug: true,
        stage: "no-works-found",
        seriesName,
        htmlLength: firstPageHtml.length,
        worksLinkCount,
        firstH4Excerpt: firstH4Idx === -1 ? null : firstPageHtml.slice(firstH4Idx, firstH4Idx + 600),
        excerpt:
          firstWorksIdx === -1
            ? firstPageHtml.slice(0, 3000)
            : firstPageHtml.slice(Math.max(0, firstWorksIdx - 800), firstWorksIdx + 2500),
      });
    }
    return jsonResponse({
      locked: true,
      seriesName,
      nextPage: 1,
      error:
        stoppedBecause === "ao3-overloaded"
          ? "AO3's server reported it was overloaded ('Page Responding Too Slowly') or actively shielding against traffic ('Shields are up!') and didn't recover after a few retries. This is on AO3's end — wait a while before retrying, since a shield can last several minutes."
          : stoppedBecause === "time-budget-exceeded"
          ? "AO3 was responding too slowly to finish within the time limit. Try again — it may work better on a retry."
          : "Found the series, but no works in it — it may be empty or restricted.",
    });
  }

  return jsonResponse({
    seriesName,
    description,
    completed: seriesCompleted,
    works: workIds.map((id) => `https://archiveofourown.org/works/${id}`),
    pagesFetched,
    stoppedBecause,
    partial: stoppedBecause === "ao3-overloaded" || stoppedBecause === "time-budget-exceeded",
    locked: false,
  });
}
