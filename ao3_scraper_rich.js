/*
 * AO3 Fandom Scraper (rich edition)
 * ----------------------------------
 * Same as before, but now pulls everything it can straight off each listing
 * blurb — rating, warnings, relationships, characters, freeform tags, word
 * count, chapters, and summary — instead of just link/title/author/fandom.
 * That means the tracker's CSV import can skip re-fetching each individual
 * work page almost entirely, which is the part that kept hitting AO3's rate
 * limiting. Confidence levels on the new fields, since I'm working from a
 * mix of confirmed and inferred AO3 markup:
 *   - rating, warnings, relationships, characters: confirmed against real
 *     AO3 blurb HTML
 *   - word count, chapters, summary: based on AO3 reusing the same class
 *     names on blurbs as on full work pages — likely right, not separately
 *     confirmed. Worth a small test run before trusting a big scrape.
 *
 * Paste this whole script into DevTools Console while logged into AO3, on
 * the listing page you want to scrape (Bookmarks, Marked for Later, History).
 */
(async function scrapeAO3() {
  const TARGET_FANDOMS = [
    "Heated Rivalry (TV)",
    "Game Changers Series - Rachel Reid",
    "Game Changers | Heated Rivalry - All Media Types"
  ].map(f => f.trim().toLowerCase());

  const SOURCE_LABEL = prompt(
    "Label this batch (e.g. 'bookmark' or 'want-to-read'):",
    "bookmark"
  ) || "unknown";

  const START_PAGE = parseInt(
    prompt("Start at which page? (use 1 unless resuming after a stop)", "1"),
    10
  ) || 1;

  function pageUrl(n) {
    const u = new URL(window.location.href);
    u.searchParams.set("page", n);
    return u.toString();
  }

  async function fetchWithRetry(url, maxRetries = 6) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 429 || res.status === 503) {
        const retryAfterHeader = res.headers.get("Retry-After");
        const waitSeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : Math.min(60, 5 * Math.pow(2, attempt));
        console.warn(`Rate-limited (status ${res.status}). Waiting ${waitSeconds}s before retry ${attempt + 1}/${maxRetries}...`);
        await new Promise(r => setTimeout(r, waitSeconds * 1000));
        continue;
      }
      return res;
    }
    throw new Error(`Gave up after ${maxRetries} retries on ${url}`);
  }

  function textOf(el) {
    return el ? el.textContent.trim().replace(/\s+/g, " ") : "";
  }

  function extractItems(doc) {
    const out = [];
    const headingLinks = doc.querySelectorAll(
      'h4.heading a[href^="/works/"], h4.heading a[href^="/series/"]'
    );
    headingLinks.forEach(linkEl => {
      const heading = linkEl.closest("h4.heading");
      const container = heading ? heading.closest('[class*="blurb"]') : null;
      if (!container) return;

      const href = linkEl.getAttribute("href");
      const link = new URL(href, location.origin).href.split("?")[0].split("#")[0];
      const title = linkEl.textContent.trim();
      const type = href.includes("/series/") ? "series" : "fic";

      const authors = Array.from(container.querySelectorAll('a[rel="author"]'))
        .map(a => a.textContent.trim())
        .join(", ") || "Anonymous";

      const fandoms = Array.from(container.querySelectorAll('[class*="fandoms"] a'))
        .map(a => a.textContent.trim());

      const relationships = Array.from(container.querySelectorAll('[class*="relationships"] a.tag'))
        .map(a => a.textContent.trim());

      const characters = Array.from(container.querySelectorAll('[class*="characters"] a.tag'))
        .map(a => a.textContent.trim());

      const freeforms = Array.from(container.querySelectorAll('[class*="freeform"] a.tag'))
        .map(a => a.textContent.trim());

      // Archive Warnings: prefer the full tag list (can be more than one), not just the icon.
      const warningTags = Array.from(container.querySelectorAll('[class*="warnings"] a.tag'))
        .map(a => a.textContent.trim());
      const warningIcon = container.querySelector(".warnings[title]");
      const warnings = warningTags.length ? warningTags : (warningIcon ? [warningIcon.getAttribute("title")] : []);

      const ratingIcon = container.querySelector(".rating[title]");
      const rating = ratingIcon ? ratingIcon.getAttribute("title") : "";

      const wordsEl = container.querySelector("dd.words");
      const wordCount = wordsEl ? wordsEl.textContent.replace(/[^\d]/g, "") : "";

      const chaptersEl = container.querySelector("dd.chapters");
      const chapters = textOf(chaptersEl);

      const summaryEl = container.querySelector("blockquote.userstuff");
      const summary = textOf(summaryEl);

      const dateEl = container.querySelector("p.datetime");
      const blurbDate = textOf(dateEl);

      out.push({
        link, title, type, authors, fandoms, relationships, characters, freeforms,
        rating, warnings, wordCount, chapters, summary, blurbDate
      });
    });
    return out;
  }

  function hasNext(doc) {
    return !!doc.querySelector("li.next a");
  }

  let all = [];
  let n = START_PAGE;
  while (true) {
    const url = pageUrl(n);
    console.log("Fetching page", n, url);
    let res;
    try {
      res = await fetchWithRetry(url);
    } catch (e) {
      console.warn("Stopping — could not fetch page", n, ":", e.message);
      console.warn(`To resume, re-run the script and start at page ${n}.`);
      break;
    }
    if (!res.ok) {
      console.warn("Got status", res.status, "- stopping. Resume from page", n, "if needed.");
      break;
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = extractItems(doc);
    if (items.length === 0) {
      console.log("No items found on page", n, "- stopping");
      break;
    }
    all = all.concat(items);
    if (!hasNext(doc)) {
      console.log("No further pages - done");
      break;
    }
    n++;
    await new Promise(r => setTimeout(r, 2500 + Math.random() * 1500));
  }

  console.log(`Scraped ${all.length} total entries across all pages.`);

  const filtered = all.filter(it =>
    it.fandoms.some(f => TARGET_FANDOMS.includes(f.toLowerCase()))
  );

  const seen = new Set();
  const deduped = filtered.filter(it => {
    if (seen.has(it.link)) return false;
    seen.add(it.link);
    return true;
  });

  console.log(`${deduped.length} matched your target fandoms (after de-duping).`);

  function esc(v) {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const header = [
    "link", "title", "type", "authors", "fandoms", "relationships", "characters",
    "freeforms", "rating", "warnings", "wordCount", "chapters", "summary",
    "blurbDate", "source"
  ];
  const lines = [header.join(",")];
  deduped.forEach(it => {
    lines.push([
      esc(it.link),
      esc(it.title),
      esc(it.type),
      esc(it.authors),
      esc(it.fandoms.join("; ")),
      esc(it.relationships.join("; ")),
      esc(it.characters.join("; ")),
      esc(it.freeforms.join("; ")),
      esc(it.rating),
      esc(it.warnings.join("; ")),
      esc(it.wordCount),
      esc(it.chapters),
      esc(it.summary),
      esc(it.blurbDate),
      esc(SOURCE_LABEL)
    ].join(","));
  });

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `ao3_${SOURCE_LABEL.replace(/\s+/g, "_")}_export.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  console.log("CSV downloaded:", a.download);
})();
