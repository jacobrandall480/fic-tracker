// Fetches an AO3 work page server-side (no CORS issue here, since this runs on Cloudflare's
// servers, not in the user's browser) and parses out the metadata fields the tracker needs.
// No API key, no AI guessing — just reading the actual page.
//
// Ported from a Netlify Function — same logic, adapted to Cloudflare Pages Functions'
// onRequestGet(context) convention and context.env instead of process.env.
//
// UPDATED: credential resolution for locked fics now supports per-user saved AO3 logins,
// not just the owner's shared env vars. See "resolveCredentials" below — everything else
// in this file is unchanged from before.

import { decryptString } from "./lib/crypto.js";

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

function extractDdBlock(html, classNames) {
  const names = Array.isArray(classNames) ? classNames : [classNames];
  for (const name of names) {
    const re = new RegExp(`<dd class="${name} tags">([\\s\\S]*?)<\\/dd>`, "i");
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractTagList(block) {
  if (!block) return [];
  const tags = [];
  const re = /<a class="tag"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = re.exec(block))) tags.push(decodeEntities(m[1]).trim());
  return tags;
}

const RATING_MAP = {
  "Not Rated": "NR",
  "General Audiences": "G",
  "Teen And Up Audiences": "T",
  Mature: "M",
  Explicit: "E",
};

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isOverloadResponse(html) {
  return /page responding too slowly|retry later|shields are up/i.test(html) || html.length < 200;
}

function backoffMs(attempt) {
  const base = 1200 * 2 ** attempt;
  const jitter = Math.random() * 500;
  return base + jitter;
}

function toMobileUrl(url) {
  return url.replace(/^https:\/\/(www\.)?archiveofourown\.org/, "https://m.archiveofourown.org");
}

async function fetchWorkWithRetry(url, options) {
  let html = null;
  let lastResp = null;
  const ATTEMPTS = 4;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const retryAfter = lastResp && lastResp.headers.get("retry-after");
      await sleep(retryAfter ? Number(retryAfter) * 1000 : backoffMs(attempt));
    }
    lastResp = await fetchWithTimeout(url, options);
    html = await lastResp.text();
    if (!isOverloadResponse(html)) {
      return html;
    }
  }

  try {
    const mobileResp = await fetchWithTimeout(toMobileUrl(url), options);
    const mobileHtml = await mobileResp.text();
    if (!isOverloadResponse(mobileHtml)) {
      return mobileHtml;
    }
  } catch {
    // fall through to giving up below
  }

  return html;
}

function cookieHeaderFromResponse(resp) {
  const arr = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  if (arr.length === 0) {
    const single = resp.headers.get("set-cookie");
    if (single) arr.push(single);
  }
  return arr.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

function mergeCookieHeaders(...headers) {
  const map = {};
  for (const h of headers) {
    if (!h) continue;
    for (const part of h.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) map[k] = v;
    }
  }
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// --- NEW: figure out whose AO3 credentials (if anyone's) to use for this request. ---
//
// Priority:
//   1. Request is from the owner (userId matches env.OWNER_UID) -> use env.AO3_USERNAME/PASSWORD.
//      Set OWNER_UID once as a Cloudflare secret to your own Firebase Auth UID.
//   2. Otherwise, if the request included ao3Username + ao3PasswordEnc (the frontend already
//      fetched these from that user's own Firestore doc), decrypt and use those.
//   3. Otherwise, no credentials at all — locked fics will just come back "locked" as before.
//
// This function replaces the old behavior where ao3Login() unconditionally read
// env.AO3_USERNAME/env.AO3_PASSWORD for every single request, regardless of who was asking.
async function resolveCredentials({ env, userId, ao3Username, ao3PasswordEnc }) {
  if (env.OWNER_UID && userId && userId === env.OWNER_UID) {
    return { username: env.AO3_USERNAME, password: env.AO3_PASSWORD };
  }
  if (ao3Username && ao3PasswordEnc) {
    try {
      const password = await decryptString(ao3PasswordEnc, env.ENCRYPTION_KEY);
      return { username: ao3Username, password };
    } catch {
      // bad/corrupt ciphertext, or wrong key — treat as no credentials rather than throwing
      return { username: null, password: null };
    }
  }
  return { username: null, password: null };
}

// Only runs when a work comes back locked AND we resolved a username/password for this
// request (either the owner's env vars, or a per-user saved+decrypted login). Logs in fresh
// each time (simpler and more robust than trying to persist a session across separate,
// stateless function invocations).
async function ao3Login(username, password) {
  if (!username || !password) return null;

  try {
    const loginPageResp = await fetchWithTimeout("https://archiveofourown.org/users/login", { headers: BROWSER_HEADERS });
    const loginPageHtml = await loginPageResp.text();
    const tokenMatch = loginPageHtml.match(/name="authenticity_token" value="([^"]+)"/);
    if (!tokenMatch) return null;
    const initialCookies = cookieHeaderFromResponse(loginPageResp);

    const body = new URLSearchParams({
      authenticity_token: tokenMatch[1],
      "user[login]": username,
      "user[password]": password,
      "user[remember_me]": "1",
      commit: "Log In",
    });

    const loginResp = await fetchWithTimeout("https://archiveofourown.org/users/login", {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: initialCookies,
      },
      body: body.toString(),
      redirect: "manual",
    });

    const loginCookies = cookieHeaderFromResponse(loginResp);
    if (!loginCookies) return null;
    return mergeCookieHeaders(initialCookies, loginCookies);
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const reqUrl = new URL(request.url);
  const url = reqUrl.searchParams.get("url") || "";
  const debug = reqUrl.searchParams.get("debug") === "1";
  const workMatch = url.match(/^https:\/\/(www\.|m\.)?archiveofourown\.org\/works\/(\d+)/);

  // NEW: read the optional credential-related query params. The frontend adds these when
  // calling fetch-fic for a fic that might be locked (see SETUP_GUIDE.md for the frontend side).
  const userId = reqUrl.searchParams.get("userId") || "";
  const ao3Username = reqUrl.searchParams.get("ao3Username") || "";
  const ao3PasswordEnc = reqUrl.searchParams.get("ao3PasswordEnc") || "";

  if (!workMatch) {
    return jsonResponse({ error: "Please paste a link to an AO3 work page (archiveofourown.org/works/...)." }, 400);
  }

  const cleanUrl = `https://archiveofourown.org/works/${workMatch[2]}?view_adult=true`;

  let html;
  try {
    html = await fetchWorkWithRetry(cleanUrl, { headers: BROWSER_HEADERS });
  } catch (e) {
    return jsonResponse({ error: "Couldn't reach AO3 right now. Try again in a moment." }, 502);
  }

  const ao3Overloaded = isOverloadResponse(html);
  const titleMatch0 = html.match(/<h2 class="title heading">\s*([\s\S]*?)\s*<\/h2>/);
  let titleMatch = titleMatch0;
  let usedLogin = false;

  // Only attempt login if the page loaded fine but genuinely isn't the work (i.e. likely
  // restricted) — not when AO3 itself was the problem, since login won't fix that and just
  // adds more slow requests on top of an already-struggling server.
  if (!titleMatch && !ao3Overloaded) {
    const { username, password } = await resolveCredentials({ env, userId, ao3Username, ao3PasswordEnc });
    const cookie = await ao3Login(username, password);
    if (cookie) {
      try {
        const resp2 = await fetchWithTimeout(cleanUrl, { headers: { ...BROWSER_HEADERS, Cookie: cookie } });
        html = await resp2.text();
        titleMatch = html.match(/<h2 class="title heading">\s*([\s\S]*?)\s*<\/h2>/);
        usedLogin = true;
      } catch {
        // fall through to the locked response below
      }
    }
  }

  if (!titleMatch) {
    const base = {
      locked: true,
      ao3Overloaded,
      usedLogin,
      error: ao3Overloaded
        ? "AO3's server reported it was overloaded ('Page Responding Too Slowly') and didn't recover after a few retries. This is on AO3's end — wait a bit and try again."
        : usedLogin
        ? "Signed in, but still couldn't read this work — it may be restricted to a specific group or deleted."
        : "Couldn't read this work's details — it may be restricted to logged-in AO3 users. Save your AO3 login in Settings to let the app sign in automatically for these.",
    };
    if (debug) {
      base.debug = true;
      base.htmlLength = html.length;
      base.containsTitleHeading = html.includes('<h2 class="title heading">');
      base.containsLoginForm = html.includes("new_user_session_small");
      base.excerpt = html.slice(0, 2500);
    }
    return jsonResponse(base);
  }

  const title = stripTags(titleMatch[1]);

  const authorMatch = html.match(/rel="author"[^>]*>([^<]+)</);
  const author = authorMatch ? decodeEntities(authorMatch[1]).trim() : null;

  const summaryMatch = html.match(
    /<div class="summary module">[\s\S]*?<blockquote class="userstuff">([\s\S]*?)<\/blockquote>/
  );
  const summary = summaryMatch ? stripTags(summaryMatch[1]) : null;

  const ratingText = extractTagList(extractDdBlock(html, "rating"))[0];
  const rating = RATING_MAP[ratingText] || null;
  const warnings = extractTagList(extractDdBlock(html, ["warnings", "warning"]));
  const fandoms = extractTagList(extractDdBlock(html, "fandom"));
  const relationships = extractTagList(extractDdBlock(html, "relationship"));
  const characters = extractTagList(extractDdBlock(html, "character"));
  const tags = extractTagList(extractDdBlock(html, "freeform"));

  const wordsMatch = html.match(/<dd class="words">([\d,]+)<\/dd>/);
  const wordCount = wordsMatch ? Number(wordsMatch[1].replace(/,/g, "")) : null;

  const chaptersMatch =
    html.match(/<dd class="chapters">\s*<a[^>]*>(\d+)<\/a>\/(\d+|\?)\s*<\/dd>/) ||
    html.match(/<dd class="chapters">\s*(\d+)\/(\d+|\?)\s*<\/dd>/);
  let chapterCurrent = null;
  let chapterTotal = null;
  let ficStatus = null;
  if (chaptersMatch) {
    chapterCurrent = Number(chaptersMatch[1]);
    chapterTotal = chaptersMatch[2] === "?" ? null : Number(chaptersMatch[2]);
    ficStatus = chapterTotal && chapterCurrent === chapterTotal ? "Complete" : "WIP";
  }

  const publishedMatch = html.match(/<dt[^>]*>Published:<\/dt>\s*<dd[^>]*>([\d-]+)<\/dd>/);
  const completedMatch = html.match(/<dt[^>]*>Completed:<\/dt>\s*<dd[^>]*>([\d-]+)<\/dd>/);
  const updatedMatch = html.match(/<dt[^>]*>Updated:<\/dt>\s*<dd[^>]*>([\d-]+)<\/dd>/);
  const published = publishedMatch ? publishedMatch[1] : null;
  const completed = completedMatch ? completedMatch[1] : null;
  const updatedRaw = updatedMatch ? updatedMatch[1] : null;

  const dateStarted = published;
  let dateFinished = null;
  let lastUpdated = null;
  if (chapterTotal === 1) {
    dateFinished = published;
  } else if (ficStatus === "Complete") {
    dateFinished = completed || published;
  } else {
    lastUpdated = updatedRaw || published;
  }

  const seriesMatch = html.match(/Part (\d+) of[\s\S]{0,40}?<a[^>]*>([^<]+)<\/a>\s*series/);
  const seriesPosition = seriesMatch ? Number(seriesMatch[1]) : null;
  const seriesName = seriesMatch ? stripTags(seriesMatch[2]) : null;

  let debugInfo = {};
  if (debug) {
    const warnIdx = html.search(/Warning/i);
    const statsIdx = html.search(/Published:/i);
    debugInfo = {
      debug: true,
      warningsContext: warnIdx === -1 ? null : html.slice(Math.max(0, warnIdx - 200), warnIdx + 900),
      statsContext: statsIdx === -1 ? null : html.slice(Math.max(0, statsIdx - 100), statsIdx + 1200),
    };
  }

  return jsonResponse({
    title,
    author,
    fandoms,
    relationships,
    characters,
    rating,
    warnings,
    wordCount,
    chapterCurrent,
    chapterTotal,
    ficStatus,
    dateStarted,
    dateFinished,
    lastUpdated,
    summary,
    tags,
    seriesName,
    seriesPosition,
    locked: false,
    ...debugInfo,
  });
}
