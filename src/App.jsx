import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  BookOpen, Search, Plus, X, RotateCcw, Download, Upload,
  Trash2, Pencil, Link2, Users, Layers,
  BarChart3, Heart, Loader2, AlertTriangle, Settings, Bookmark,
  Inbox, Check, LogOut, Mail, Lock, HelpCircle, ChevronDown, ChevronRight, Undo2, Copy
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import {
  watchAuth, signUp, signIn, signOutUser, watchLibrary, saveFicsDiff, saveLists,
  watchTrash, restoreFromTrash, permanentlyDeleteTrash, purgeExpiredTrash,
  getAo3Credentials, saveAo3Credentials, removeAo3Credentials,
} from "./firebase.js";
import Papa from "papaparse";

/* ---------------------------------------------------------------- */
/* Constants                                                         */
/* ---------------------------------------------------------------- */

// "Caught Up" sits between "Currently Reading" and "Completed" — it's for a WIP you've
// read everything posted so far of, but the fic itself isn't done, so calling it
// "Completed" would be wrong. Keeping it out of "Currently Reading" is the whole point
// (so finished-for-now WIPs stop cluttering that filter) while still being its own
// filterable status, so you can pull up exactly the WIPs you're waiting on later.
const READING_STATUSES = ["Unread", "Currently Reading", "Caught Up", "Completed", "On Hold", "Abandoned"];
const FIC_STATUSES = ["Complete", "WIP", "Hiatus"];
const RATINGS = ["NR", "G", "T", "M", "E"];
const COMMON_WARNINGS = [
  "Graphic Depictions Of Violence",
  "Major Character Death",
  "Rape/Non-Con",
  "Underage",
  "No Archive Warnings Apply",
  "Creator Chose Not To Use Archive Warnings",
];

const READING_COLOR = {
  Unread: "var(--c-muted)",
  "Currently Reading": "var(--c-blue)",
  "Caught Up": "var(--c-gold)",
  Completed: "var(--c-sage)",
  "On Hold": "var(--c-accent)",
  Abandoned: "var(--c-rose)",
};
const FIC_COLOR = { Complete: "var(--c-sage)", WIP: "var(--c-blue)", Hiatus: "var(--c-rose)" };
const RATING_COLOR = { NR: "var(--c-muted)", G: "var(--c-sage)", T: "var(--c-blue)", M: "var(--c-rose)", E: "var(--c-accent)" };

const NAV_ITEMS = [
  { id: "library", label: "Library", icon: BookOpen },
  { id: "recs", label: "Recs", icon: Inbox },
  { id: "series", label: "Series", icon: Layers },
  { id: "collections", label: "Collections", icon: Bookmark },
  { id: "authors", label: "Authors", icon: Users },
  { id: "stats", label: "Stats", icon: BarChart3 },
];

/* ---------------------------------------------------------------- */
/* Helpers                                                            */
/* ---------------------------------------------------------------- */

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncateTitle = (t, max = 40) => {
  const s = (t || "Untitled").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
};

// UI preferences only (filters, sort, what's collapsed) — not library data, which lives in
// Firestore. Scoped to this browser; safe to use real localStorage since this is a normal
// deployed web app, not a sandboxed artifact.
const UI_STATE_KEY = "ficTrackerUIState";
function loadUIState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function pickField(row, names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const match = keys.find((k) => k.trim().toLowerCase() === name);
    if (match && row[match]) return row[match].trim();
  }
  return "";
}

function statusFromShelfName(source) {
  const s = (source || "").toLowerCase();
  if (/want|tbr|to.?read|wishlist|plan/.test(s)) return "Unread";
  if (/reading|current|in.?progress/.test(s)) return "Currently Reading";
  if (/read|complete|finish|done/.test(s)) return "Completed";
  return "Unread";
}

const CSV_RATING_MAP = { "Not Rated": "NR", "General Audiences": "G", "Teen And Up Audiences": "T", Mature: "M", Explicit: "E" };
function parseCsvRating(text) {
  if (!text) return "";
  if (CSV_RATING_MAP[text]) return CSV_RATING_MAP[text];
  const upper = text.trim().toUpperCase();
  return ["NR", "G", "T", "M", "E"].includes(upper) ? upper : "";
}
// AO3 shows "?" for a WIP's total chapter count when the author hasn't said how many
// there'll be — every scrape path (single bookmarklet, bulk bookmarklet, server fetch,
// CSV chapters column) already parses that into `null` to distinguish it from "we just
// don't have data here at all". This folds that `null` into the app's own "?" sentinel
// (the same character AO3 uses, so it reads naturally everywhere chapterTotal is
// displayed) — a real number passes through untouched, and anything else (missing/blank/
// undefined — genuinely no info, not a confirmed "unknown") keeps whatever fallback the
// caller already had.
function normalizeChapterTotal(value, fallback) {
  if (value === null || value === "?") return "?";
  if (typeof value === "number" && value > 0) return value;
  return fallback;
}

// When a scrape/import doesn't give us an explicit ficStatus, infer it from chapter
// counts if we can — and if we genuinely can't (unknown total, or no chapter data at
// all), default to "WIP" rather than "Complete". A wrong "WIP" just means you get
// prompted to check on it later; a wrong "Complete" silently claims a fic is finished
// (wrong badge, wrong "finished" date, drops out of WIP tracking) when it might not be.
function inferFicStatus(ficStatus, chapterCurrent, chapterTotal) {
  if (ficStatus) return ficStatus;
  if (typeof chapterTotal === "number" && chapterTotal > 0) {
    return chapterCurrent === chapterTotal ? "Complete" : "WIP";
  }
  return "WIP";
}

function parseChaptersText(text) {
  const m = (text || "").match(/^(\d+)\s*\/\s*(\d+|\?)$/);
  if (!m) return { current: null, total: null };
  return { current: Number(m[1]), total: m[2] === "?" ? null : Number(m[2]) };
}

// Old fics stored a single seriesName/seriesPosition pair (now seriesEntries, an array) and
// a field called rereadCount (now readCount, since it tracks every completion, not just
// rereads). This upgrades old records on the fly without needing a one-time migration write.
function normalizeFic(f) {
  let next = f;
  if (!next.seriesEntries) {
    const entries = next.seriesName ? [{ seriesName: next.seriesName, seriesPosition: next.seriesPosition || "" }] : [];
    next = { ...next, seriesEntries: entries };
  }
  if (next.readCount === undefined && next.rereadCount !== undefined) {
    next = { ...next, readCount: next.rereadCount };
  }
  // chapterCurrent/chapterTotal used to double as both "chapters AO3 has posted" AND "your
  // reading progress" — the same field meant two different things depending on how it was
  // last touched. readChapter now owns reading progress exclusively; chapterCurrent always
  // means AO3's posted count. For fics that predate this split, seed readChapter from
  // whatever chapterCurrent currently holds — UNLESS the fic is marked Unread, in which
  // case reading progress is 0 by definition no matter what chapterCurrent says (an unread
  // fic having a non-zero "chapters read" was exactly this kind of leftover confusion).
  // chapterCurrent itself gets corrected to the real posted count next time the fic is
  // re-fetched or re-imported.
  if (next.readChapter === undefined) {
    next = { ...next, readChapter: next.readingStatus === "Unread" ? 0 : (next.chapterCurrent || 0) };
  } else if (next.readingStatus === "Unread" && next.readChapter !== 0) {
    // Also self-corrects any fic that already got a non-zero readChapter written to
    // storage by the earlier version of this migration, before this fix existed.
    next = { ...next, readChapter: 0 };
  }
  return next;
}
const parseList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
const joinList = (a) => (a || []).join(", ");
const fmtNum = (n) => Math.round(n || 0).toLocaleString();
const fmtDate = (d) => {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt)) return "—";
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
const detectSource = (url) => {
  if (!url) return "Other";
  if (url.includes("archiveofourown.org")) return "AO3";
  if (url.includes("fanfiction.net")) return "FFN";
  if (url.includes("wattpad.com")) return "Wattpad";
  return "Other";
};
// "How far through the fic have you read" — measured against what's actually posted right
// now (chapterCurrent), not the eventual total (chapterTotal), since you can't have read
// chapters that haven't been written yet. For a complete fic these are the same number.
const progressOf = (f) => {
  if (f.chapterCurrent && f.chapterCurrent > 0) {
    return Math.max(0, Math.min(100, Math.round(((f.readChapter || 0) / f.chapterCurrent) * 100)));
  }
  return f.progressPercent || 0;
};
const wordsReadOf = (f) => {
  if (f.readingStatus === "Completed" || f.readingStatus === "Caught Up") return f.wordCount || 0;
  return Math.round((f.wordCount || 0) * (progressOf(f) / 100));
};

// Extracts just the numeric work id from an AO3 URL, ignoring everything else — a
// chapter-specific link (.../works/12345/chapters/67890) and the canonical work link
// (.../works/12345) both reduce to the same id, even though they're different strings.
function ao3WorkId(url) {
  const m = String(url || "").match(/works\/(\d+)/);
  return m ? m[1] : null;
}

function findDuplicate(draft, fics, excludeId) {
  const link = (draft.link || "").trim().toLowerCase();
  const title = (draft.title || "").trim().toLowerCase();
  const author = (draft.author || "").trim().toLowerCase();
  const draftWorkId = ao3WorkId(draft.link);
  return (
    fics.find((f) => {
      if (f.id === excludeId) return false;
      // Compare by AO3 work id first — this is what actually makes a chapter-specific
      // link (common in older imports/exports) correctly match a freshly-scraped
      // canonical link for the same work, which an exact string comparison can't do.
      if (draftWorkId && ao3WorkId(f.link) === draftWorkId) return true;
      if (link && (f.link || "").trim().toLowerCase() === link) return true;
      if (title && author && f.title.trim().toLowerCase() === title && f.author.trim().toLowerCase() === author) return true;
      return false;
    }) || null
  );
}

// Adds any series memberships from `freshEntries` that `existingEntries` doesn't already
// have, updating a stale position if one's given — never drops a membership that's
// already there. `freshEntries` can be the seriesEntries array shape (manual edit/add) or
// a single {seriesName, seriesPosition} shape (a raw AO3 scrape) — callers normalize
// either into an array before calling this.
function mergeSeriesEntries(existingEntries, freshEntries) {
  let merged = existingEntries || [];
  (freshEntries || []).forEach((fe) => {
    if (!fe || !fe.seriesName) return;
    const idx = merged.findIndex((e) => e.seriesName === fe.seriesName);
    if (idx === -1) {
      merged = [...merged, { seriesName: fe.seriesName, seriesPosition: fe.seriesPosition ?? "" }];
    } else if (fe.seriesPosition != null && fe.seriesPosition !== "" && merged[idx].seriesPosition !== fe.seriesPosition) {
      merged = merged.map((e, i) => (i === idx ? { ...e, seriesPosition: fe.seriesPosition } : e));
    }
  });
  return merged;
}

function emptyFic() {
  return {
    id: genId(),
    title: "",
    author: "",
    fandoms: [],
    relationships: [],
    characters: [],
    rating: "T",
    warnings: [],
    wordCount: 0,
    chapterCurrent: 0, // chapters AO3 has actually posted right now — not your reading progress
    chapterTotal: 1, // chapters the fic will have once complete (AO3's own stated total)
    readChapter: 0, // YOUR reading progress — which posted chapter you're on; capped at chapterCurrent
    lastReadUrl: "", // exact AO3 chapter URL you last updated progress from — "Continue reading" opens this instead of the bare work link
    link: "",
    source: "AO3",
    readingStatus: "Unread",
    ficStatus: "Complete",
    dateAdded: today(),
    dateStarted: "",
    dateFinished: "",
    lastUpdated: "",
    progressPercent: 0,
    readCount: 0,
    tags: [],
    seriesEntries: [],
    collections: [],
    addedVia: "self",
    recommendedBy: "",
    summary: "",
    notes: "",
  };
}

/* ---------------------------------------------------------------- */
/* AO3 link import — calls our own Netlify function, which reads the   */
/* actual AO3 page server-side (no API key, no CORS issue).            */
/* ---------------------------------------------------------------- */

async function fetchMetadataFromLink(url, uid) {
  const params = new URLSearchParams({ url });
  if (uid) {
    params.set("userId", uid);
    try {
      const creds = await getAo3Credentials(uid);
      if (creds?.ao3Username) params.set("ao3Username", creds.ao3Username);
      if (creds?.ao3PasswordEnc) params.set("ao3PasswordEnc", creds.ao3PasswordEnc);
    } catch {
      // no saved credentials, or couldn't read them — proceed unauthenticated, same as before
    }
  }
  const resp = await fetch(`/fetch-fic?${params.toString()}`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error("Unexpected response from the lookup — try again, or fill in manually.");
  }
  if (!data || (data.error && !data.title)) {
    const err = new Error(data?.error || "Couldn't fetch that link.");
    err.locked = !!data?.locked;
    throw err;
  }
  return data;
}

/* ---------------------------------------------------------------- */
/* Small shared UI bits                                              */
/* ---------------------------------------------------------------- */

function Badge({ color, children }) {
  return (
    <span className="ft-badge" style={{ "--bc": color }}>
      {children}
    </span>
  );
}

function ProgressBar({ pct, color }) {
  return (
    <div className="ft-progress-track">
      <div className="ft-progress-fill" style={{ width: `${pct}%`, background: color || "var(--c-blue)" }} />
    </div>
  );
}

function Modal({ title, onClose, children, wide, onEnter }) {
  const handleKeyDown = (e) => {
    if (e.key !== "Enter" || !onEnter) return;
    const tag = e.target.tagName;
    if (tag === "TEXTAREA" || tag === "BUTTON") return; // let newlines through; buttons already handle their own Enter/click
    e.preventDefault();
    onEnter();
  };
  return (
    <div className="ft-modal-backdrop" onClick={onClose}>
      <div className={"ft-modal" + (wide ? " ft-modal-wide" : "")} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="ft-modal-head">
          <h2>{title}</h2>
          <button className="ft-iconbtn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="ft-modal-body">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label className="ft-field">
      <span className="ft-field-label">{label}</span>
      {children}
      {hint && <span className="ft-field-hint">{hint}</span>}
    </label>
  );
}

function EmptyState({ icon: Icon, title, body }) {
  return (
    <div className="ft-empty">
      <Icon size={28} strokeWidth={1.5} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function HelpTooltip({ children }) {
  return (
    <span className="ft-tooltip" tabIndex={0}>
      <HelpCircle size={14} />
      <span className="ft-tooltip-bubble">{children}</span>
    </span>
  );
}

function MultiSelectFilter({ label, options, selected, onChange, placeholder, counts }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
    return list.slice(0, 100);
  }, [options, query]);

  const toggle = (opt) => {
    onChange(selected.includes(opt) ? selected.filter((s) => s !== opt) : [...selected, opt]);
  };

  return (
    <div className="ft-multiselect" ref={ref}>
      <button type="button" className="ft-filter-input ft-multiselect-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{selected.length === 0 ? placeholder : `${label}: ${selected.length} selected`}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="ft-multiselect-panel">
          <input
            autoFocus
            type="text"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="ft-multiselect-search"
          />
          <div className="ft-multiselect-list">
            {filtered.length === 0 ? (
              <div className="ft-multiselect-empty">No matches</div>
            ) : (
              filtered.map((opt) => (
                <label key={opt} className="ft-multiselect-option">
                  <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)} />
                  {opt}{counts && counts[opt] != null && <span className="ft-muted"> ({counts[opt]})</span>}
                </label>
              ))
            )}
          </div>
          {selected.length > 0 && (
            <button type="button" className="ft-multiselect-clear" onClick={() => onChange([])}>
              Clear all
            </button>
          )}
        </div>
      )}

      {selected.length > 0 && (
        <div className="ft-multiselect-chips">
          {selected.map((s) => (
            <span key={s} className="ft-chip ft-multiselect-chip">
              {s}
              <button type="button" onClick={() => toggle(s)} aria-label={`Remove ${s}`}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Fic card + edit form                                              */
/* ---------------------------------------------------------------- */

function FicCard({ fic, onEdit, onDelete, onQuickStatus, confirmingDelete }) {
  const pct = progressOf(fic);
  return (
    <div className="ft-card">
      <div className="ft-card-top">
        <div className="ft-card-title-wrap">
          <a
            href={fic.readingStatus === "Completed" ? (fic.link || undefined) : (fic.lastReadUrl || fic.link || undefined)}
            target="_blank"
            rel="noreferrer"
            className="ft-card-title"
            title={
              fic.readingStatus === "Completed"
                ? "Open on AO3 (from the top)"
                : fic.lastReadUrl && fic.lastReadUrl !== fic.link
                ? "Continue reading on AO3"
                : "Open on AO3"
            }
          >
            {fic.title || "Untitled"}
          </a>
          <div className="ft-card-author">by {fic.author || "Unknown"}</div>
        </div>
        <div className="ft-card-actions">
          <button className="ft-iconbtn" onClick={() => onEdit(fic)} title="Edit">
            <Pencil size={15} />
          </button>
          <button
            className={"ft-iconbtn" + (confirmingDelete ? " ft-iconbtn-danger-active" : "")}
            onClick={() => onDelete(fic.id)}
            title={confirmingDelete ? "Click again to confirm" : "Delete"}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="ft-chiprow">
        {(fic.seriesEntries || []).map((entry) => (
          <span key={entry.seriesName} className="ft-chip ft-chip-series">
            <Layers size={11} /> {entry.seriesName} #{entry.seriesPosition || "?"}
          </span>
        ))}
        {(fic.fandoms || []).slice(0, 3).map((f) => (
          <span key={f} className="ft-chip">{f}</span>
        ))}
        {(fic.relationships || []).slice(0, 2).map((r) => (
          <span key={r} className="ft-chip ft-chip-ship">{r}</span>
        ))}
      </div>

      <div className="ft-card-meta">
        <Badge color={RATING_COLOR[fic.rating]}>{fic.rating}</Badge>
        <Badge color={READING_COLOR[fic.readingStatus]}>{fic.readingStatus}</Badge>
        <Badge color={FIC_COLOR[fic.ficStatus]}>{fic.ficStatus}</Badge>
        {fic.addedVia === "rec" && <Badge color="var(--c-rose)">rec: {fic.recommendedBy || "friend"}</Badge>}
        <Badge color="var(--c-gold)"><RotateCcw size={11} /> Read ×{fic.readCount || 0}</Badge>
      </div>

      <div className="ft-card-bottom">
        <div className="ft-card-progress">
          <ProgressBar pct={pct} color={READING_COLOR[fic.readingStatus]} />
          <span className="ft-card-progress-label">
            {fic.chapterCurrent
              ? `Read ${fic.readChapter || 0}/${fic.chapterCurrent}${fic.chapterCurrent !== fic.chapterTotal ? ` posted (${fic.chapterTotal} planned)` : ""}`
              : `${pct}%`} · {fmtNum(fic.wordCount)} words
          </span>
        </div>
        <div className="ft-card-dates">
          {fic.ficStatus === "Complete"
            ? `Fic finished ${fmtDate(fic.dateFinished || fic.dateAdded)}`
            : `Updated ${fmtDate(fic.lastUpdated || fic.dateAdded)}`}
        </div>
      </div>

      <div className="ft-card-quickrow">
        {fic.readingStatus !== "Unread" && (
          <button className="ft-pill" onClick={() => onQuickStatus(fic.id, "Unread")}>Mark unread</button>
        )}
        {fic.readingStatus !== "Currently Reading" && (
          <button className="ft-pill" onClick={() => onQuickStatus(fic.id, "Currently Reading")}>
            {(fic.readCount || 0) > 0 ? "Read again" : "Start reading"}
          </button>
        )}
        {fic.ficStatus !== "Complete" ? (
          fic.readingStatus !== "Caught Up" && (
            <button className="ft-pill" onClick={() => onQuickStatus(fic.id, "Caught Up")} title="You're read up to the latest posted chapter — the fic itself isn't finished yet">
              Caught up (so far)
            </button>
          )
        ) : (
          fic.readingStatus !== "Completed" && (
            <button className="ft-pill" onClick={() => onQuickStatus(fic.id, "Completed")}>Mark complete</button>
          )
        )}
      </div>
    </div>
  );
}

function SeriesBlock({
  name, meta, items, collapsed, onToggleCollapse,
  onAddToCollection, onToggleCompleted, onEdit, onDelete,
  onBulkDelete, onBulkMarkStatus, onEditFic, onDeleteFic, onQuickStatus, confirmDeleteId,
}) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());

  const toggleSelected = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const allSelected = items.length > 0 && selected.size === items.length;
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(items.map((f) => f.id)));

  return (
    <div className="ft-series-block">
      <div className="ft-series-head">
        <button className="ft-iconbtn" onClick={onToggleCollapse} aria-label={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <div style={{ flex: 1 }}>
          <h3>
            {meta?.link ? (
              <a href={meta.link} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>{name}</a>
            ) : (
              name
            )}{" "}
            <Badge color={meta?.completed ? "var(--c-sage)" : "var(--c-blue)"}>{meta?.completed ? "Complete" : "Ongoing"}</Badge>
          </h3>
          {meta?.description && <p className="ft-muted">{meta.description}</p>}
          <span className="ft-muted">
            {items.length} part{items.length !== 1 ? "s" : ""} · {fmtNum(items.reduce((sum, f) => sum + (f.wordCount || 0), 0))} words
          </span>
        </div>
        <div className="ft-card-actions">
          {items.length > 0 &&
            (selectMode ? (
              <>
                <button className="ft-pill" onClick={toggleSelectAll}>{allSelected ? "Deselect all" : "Select all"}</button>
                {selected.size > 0 && (
                  <>
                    <button className="ft-pill" onClick={() => { onBulkMarkStatus(Array.from(selected), "Completed"); exitSelectMode(); }}>
                      <Check size={13} /> Mark read
                    </button>
                    <button className="ft-pill" onClick={() => { onBulkMarkStatus(Array.from(selected), "Unread"); exitSelectMode(); }}>
                      Mark unread
                    </button>
                    <button
                      className="ft-pill ft-pill-danger"
                      onClick={() => { onBulkDelete(Array.from(selected)); exitSelectMode(); }}
                    >
                      <Trash2 size={13} /> Delete {selected.size}
                    </button>
                  </>
                )}
                <button className="ft-btn ft-btn-ghost" onClick={exitSelectMode}>Cancel</button>
              </>
            ) : (
              <button className="ft-btn ft-btn-ghost" onClick={() => setSelectMode(true)}>Select</button>
            ))}
          <button className="ft-pill" onClick={onToggleCompleted}>
            Mark {meta?.completed ? "ongoing" : "complete"}
          </button>
          <button className="ft-iconbtn" title="Add this series to a collection" onClick={() => onAddToCollection(items.map((f) => f.id))}>
            <Bookmark size={14} />
          </button>
          <button className="ft-iconbtn" title="Edit details" onClick={onEdit}>
            <Pencil size={14} />
          </button>
          <button className="ft-iconbtn" onClick={onDelete} title="Delete this series AND remove its fics from your library">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {!collapsed && (
        items.length === 0 ? (
          <p className="ft-muted">No fics in this series yet — set this name in a fic's "Series name" field to add one.</p>
        ) : (
          <div className="ft-grid">
            {items.map((f) => (
              <div key={f.id} style={{ position: "relative" }}>
                {selectMode && (
                  <label className="ft-select-overlay">
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleSelected(f.id)} />
                  </label>
                )}
                <FicCard fic={f} onEdit={onEditFic} onDelete={onDeleteFic} onQuickStatus={onQuickStatus} confirmingDelete={confirmDeleteId === f.id} />
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function CollectionBlock({
  collection, items, collapsed, onToggleCollapse, onEdit, onDelete,
  onRemoveSelected, onMoveSelected, onBulkDelete, onBulkMarkStatus, allCollections, onEditFic, onDeleteFic, onQuickStatus, confirmDeleteId,
}) {
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(new Set());

  const toggleSelected = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const allSelected = items.length > 0 && selected.size === items.length;
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(items.map((f) => f.id)));

  return (
    <div className="ft-series-block">
      <div className="ft-series-head">
        <button className="ft-iconbtn" onClick={onToggleCollapse} aria-label={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <div style={{ flex: 1 }}>
          <h3>{collection.name}</h3>
          {collection.description && <p className="ft-muted">{collection.description}</p>}
          <span className="ft-muted">{items.length} fic{items.length !== 1 ? "s" : ""} · {fmtNum(items.reduce((sum, f) => sum + (f.wordCount || 0), 0))} words</span>
        </div>
        <div className="ft-card-actions">
          {items.length > 0 &&
            (selectMode ? (
              <>
                <button className="ft-pill" onClick={toggleSelectAll}>{allSelected ? "Deselect all" : "Select all"}</button>
                {selected.size > 0 && (
                  <>
                    <button className="ft-pill" onClick={() => { onRemoveSelected(Array.from(selected)); exitSelectMode(); }}>
                      Remove {selected.size} from collection
                    </button>
                    {allCollections && allCollections.filter((c) => c.id !== collection.id).length > 0 && (
                      <select
                        className="ft-pill"
                        defaultValue=""
                        onChange={(e) => {
                          if (!e.target.value) return;
                          onMoveSelected(e.target.value, Array.from(selected));
                          exitSelectMode();
                          e.target.value = "";
                        }}
                      >
                        <option value="" disabled>Move {selected.size} to…</option>
                        {allCollections.filter((c) => c.id !== collection.id).map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    )}
                    <button className="ft-pill" onClick={() => { onBulkMarkStatus(Array.from(selected), "Completed"); exitSelectMode(); }}>
                      <Check size={13} /> Mark read
                    </button>
                    <button className="ft-pill" onClick={() => { onBulkMarkStatus(Array.from(selected), "Unread"); exitSelectMode(); }}>
                      Mark unread
                    </button>
                    <button
                      className="ft-pill ft-pill-danger"
                      onClick={() => { onBulkDelete(Array.from(selected)); exitSelectMode(); }}
                    >
                      <Trash2 size={13} /> Delete {selected.size}
                    </button>
                  </>
                )}
                <button className="ft-btn ft-btn-ghost" onClick={exitSelectMode}>Cancel</button>
              </>
            ) : (
              <button className="ft-btn ft-btn-ghost" onClick={() => setSelectMode(true)}>Select</button>
            ))}
          <button className="ft-iconbtn" onClick={onEdit}><Pencil size={14} /></button>
          <button className="ft-iconbtn" onClick={onDelete} title="Delete this collection AND remove its fics from your library"><Trash2 size={14} /></button>
        </div>
      </div>
      {!collapsed &&
        (items.length === 0 ? (
          <p className="ft-muted">No fics assigned yet — add this collection from a fic's edit form.</p>
        ) : (
          <div className="ft-grid">
            {items.map((f) => (
              <div key={f.id} style={{ position: "relative" }}>
                {selectMode && (
                  <label className="ft-select-overlay">
                    <input type="checkbox" checked={selected.has(f.id)} onChange={() => toggleSelected(f.id)} />
                  </label>
                )}
                <FicCard fic={f} onEdit={onEditFic} onDelete={onDeleteFic} onQuickStatus={onQuickStatus} confirmingDelete={confirmDeleteId === f.id} />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function AO3CredentialsSection({ uid }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hasSaved, setHasSaved] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getAo3Credentials(uid).then((creds) => {
      if (cancelled) return;
      if (creds) {
        setHasSaved(true);
        setUsername(creds.ao3Username || "");
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { cancelled = true; };
  }, [uid]);

  async function handleSave(e) {
    e.preventDefault();
    setStatus("Saving...");
    try {
      const res = await fetch("/encrypt-ao3-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error("Encryption request failed");
      const { encrypted } = await res.json();
      await saveAo3Credentials(uid, username, encrypted);
      setPassword("");
      setHasSaved(true);
      setStatus("Saved — you won't need to re-enter this for locked fics.");
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  async function handleRemove() {
    setStatus("Removing...");
    try {
      await removeAo3Credentials(uid);
      setHasSaved(false);
      setUsername("");
      setPassword("");
      setStatus("Removed.");
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }

  if (loading) return <div className="ft-settings-row"><p className="ft-muted">Loading AO3 login settings…</p></div>;

  return (
    <div className="ft-settings-row" style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>AO3 login (optional)</strong>
        <HelpTooltip>
          Only needed to fetch details for locked/restricted works. Your password is
          encrypted before it's saved, and only used to look up fics on your behalf.
        </HelpTooltip>
      </div>

      {hasSaved ? (
        <div>
          <p className="ft-muted" style={{ marginBottom: 6 }}>Saved for: <strong>{username}</strong></p>
          <button className="ft-btn ft-btn-ghost" onClick={handleRemove}>Remove saved login</button>
        </div>
      ) : (
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            className="ft-input"
            type="text"
            placeholder="AO3 username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            className="ft-input"
            type="password"
            placeholder="AO3 password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="ft-btn ft-btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>Save</button>
        </form>
      )}

      {status && <p className="ft-muted" style={{ marginTop: 6 }}>{status}</p>}
    </div>
  );
}

function FicForm({ draft, setDraft, collections, seriesNames, onCreateCollection, autoFetch, uid, onOpenSettings }) {
  const [newCollectionName, setNewCollectionName] = useState("");
  const [linkInput, setLinkInput] = useState(draft.link || "");  const [fetchState, setFetchState] = useState("idle"); // idle | loading | done | error | locked
  const [fetchError, setFetchError] = useState("");

  const doFetch = async () => {
    if (!linkInput) return;
    setFetchState("loading");
    try {
      const parsed = await fetchMetadataFromLink(linkInput, uid);
      setDraft((d) => {
        let seriesEntries = d.seriesEntries || [];
        if (parsed.seriesName) {
          const idx = seriesEntries.findIndex((e) => e.seriesName === parsed.seriesName);
          if (idx === -1) {
            seriesEntries = [...seriesEntries, { seriesName: parsed.seriesName, seriesPosition: parsed.seriesPosition ?? "" }];
          } else if (parsed.seriesPosition != null && seriesEntries[idx].seriesPosition !== parsed.seriesPosition) {
            seriesEntries = seriesEntries.map((e, i) => (i === idx ? { ...e, seriesPosition: parsed.seriesPosition } : e));
          }
        }
        return {
          ...d,
          link: linkInput,
          source: detectSource(linkInput),
          title: parsed.title || d.title,
          author: parsed.author || d.author,
          fandoms: parsed.fandoms?.length ? parsed.fandoms : d.fandoms,
          relationships: parsed.relationships?.length ? parsed.relationships : d.relationships,
          characters: parsed.characters?.length ? parsed.characters : d.characters,
          rating: parsed.rating || d.rating,
          warnings: parsed.warnings?.length ? parsed.warnings : d.warnings,
          wordCount: parsed.wordCount ?? d.wordCount,
          chapterCurrent: parsed.chapterCurrent ?? d.chapterCurrent,
          chapterTotal: normalizeChapterTotal(parsed.chapterTotal, d.chapterTotal),
          ficStatus: parsed.ficStatus || d.ficStatus,
          dateStarted: parsed.dateStarted || d.dateStarted,
          dateFinished: parsed.dateFinished || d.dateFinished,
          lastUpdated: parsed.lastUpdated || d.lastUpdated,
          summary: parsed.summary || d.summary,
          tags: parsed.tags?.length ? parsed.tags : d.tags,
          seriesEntries,
        };
      });
      setFetchState(parsed.locked ? "locked" : "done");
    } catch (e) {
      console.error(e);
      setFetchState(e.locked ? "locked" : "error");
      setFetchError(e.message);
    }
  };

  // Triggered by the "Add to Library" bookmarklet, which opens the modal with the link
  // already filled in — runs the exact same fetch a manual click on "Fetch details" would,
  // just automatically, once, right when the form mounts (not on every re-render).
  useEffect(() => {
    if (autoFetch && linkInput) {
      doFetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const setNum = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value === "" ? "" : Number(e.target.value) }));
  const setListField = (k) => (e) => setDraft((d) => ({ ...d, [k]: parseList(e.target.value) }));

  const toggleWarning = (w) => {
    setDraft((d) => {
      const has = (d.warnings || []).includes(w);
      return { ...d, warnings: has ? d.warnings.filter((x) => x !== w) : [...(d.warnings || []), w] };
    });
  };
  const toggleCollection = (id) => {
    setDraft((d) => {
      const has = (d.collections || []).includes(id);
      return { ...d, collections: has ? d.collections.filter((x) => x !== id) : [...(d.collections || []), id] };
    });
  };
  const createAndAddCollection = () => {
    const c = onCreateCollection(newCollectionName.trim());
    setDraft((d) => ({ ...d, collections: [...(d.collections || []), c.id] }));
    setNewCollectionName("");
  };

  return (
    <div className="ft-form">
      <div className="ft-form-section ft-fetchbox">
        <Field label="Link" hint="paste an AO3 work URL to auto-fill the fields below">
          <div className="ft-fetchrow">
            <input
              value={linkInput}
              onChange={(e) => {
                setLinkInput(e.target.value);
                setDraft((d) => ({ ...d, link: e.target.value, source: detectSource(e.target.value) }));
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.stopPropagation();
                if (linkInput && fetchState !== "loading") doFetch();
              }}
              placeholder="https://archiveofourown.org/works/..."
            />
            <button type="button" className="ft-btn ft-btn-primary" onClick={doFetch} disabled={fetchState === "loading" || !linkInput}>
              {fetchState === "loading" ? <Loader2 size={14} className="ft-spin" /> : <Link2 size={14} />}
              Fetch details
            </button>
          </div>
        </Field>
        {fetchState === "locked" && (
          <p className="ft-fetch-msg ft-fetch-warn">
            <AlertTriangle size={13} /> {fetchError || "This work may require an AO3 login — fill in the rest manually."}
            {onOpenSettings && (
              <>
                {" "}
                <button
                  type="button"
                  className="ft-btn ft-btn-ghost"
                  style={{ marginLeft: 6, padding: "2px 8px", fontSize: 12 }}
                  onClick={onOpenSettings}
                >
                  Add AO3 login
                </button>
              </>
            )}
          </p>
        )}
        {fetchState === "error" && (
          <p className="ft-fetch-msg ft-fetch-warn">
            <AlertTriangle size={13} /> {fetchError || "Couldn't fetch automatically. Fill in the details manually below."}
          </p>
        )}
      </div>

      <div className="ft-form-grid">
        <Field label="Title *"><input value={draft.title} onChange={set("title")} /></Field>
        <Field label="Author / pseud *"><input value={draft.author} onChange={set("author")} /></Field>
      </div>

      <div className="ft-form-grid">
        <Field label="Fandom(s)" hint="comma separated"><input value={joinList(draft.fandoms)} onChange={setListField("fandoms")} /></Field>
        <Field label="Relationship(s)" hint="comma separated"><input value={joinList(draft.relationships)} onChange={setListField("relationships")} /></Field>
      </div>
      <Field label="Characters" hint="comma separated"><input value={joinList(draft.characters)} onChange={setListField("characters")} /></Field>

      <div className="ft-form-grid ft-form-grid-3">
        <Field label="Rating">
          <select value={draft.rating} onChange={set("rating")}>
            {RATINGS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Fic status">
          <select value={draft.ficStatus} onChange={set("ficStatus")}>
            {FIC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Reading status">
          <select value={draft.readingStatus} onChange={set("readingStatus")}>
            {READING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Warnings">
        <div className="ft-checkrow">
          {COMMON_WARNINGS.map((w) => (
            <label key={w} className="ft-check">
              <input type="checkbox" checked={(draft.warnings || []).includes(w)} onChange={() => toggleWarning(w)} />
              {w}
            </label>
          ))}
        </div>
      </Field>

      <div className="ft-form-grid ft-form-grid-3">
        <Field label="Word count"><input type="number" min="0" value={draft.wordCount} onChange={setNum("wordCount")} /></Field>
        <Field label="Chapters posted (AO3)" hint="how many chapters exist right now"><input type="number" min="0" value={draft.chapterCurrent} onChange={setNum("chapterCurrent")} /></Field>
        <Field label="Chapters total (AO3)" hint='planned total when complete — type "?" if AO3 shows an unknown total'>
          <input
            type="text"
            inputMode="numeric"
            value={draft.chapterTotal}
            onChange={(e) => {
              const raw = e.target.value;
              setDraft((d) => {
                if (raw === "" || raw === "?") return { ...d, chapterTotal: raw };
                if (/^\d+$/.test(raw)) return { ...d, chapterTotal: Number(raw) };
                return d; // ignore anything else (letters, etc.) — only digits or "?" are valid here
              });
            }}
            onBlur={() => setDraft((d) => (d.chapterTotal === "" ? { ...d, chapterTotal: "?" } : d))}
          />
        </Field>
      </div>

      <div className="ft-form-grid ft-form-grid-3">
        <Field label="My reading progress" hint={`which posted chapter you're on (max ${draft.chapterCurrent || 0})`}>
          <input
            type="number"
            min="0"
            max={draft.chapterCurrent || 0}
            value={draft.readChapter || 0}
            onChange={(e) => {
              const v = e.target.value === "" ? 0 : Number(e.target.value);
              const capped = Math.max(0, Math.min(v, draft.chapterCurrent || 0));
              setDraft((d) =>
                capped === (d.readChapter || 0)
                  ? d
                  : { ...d, readChapter: capped, lastReadUrl: "" } // progress no longer matches whatever chapter lastReadUrl pointed to
              );
            }}
          />
        </Field>
      </div>

      {!draft.chapterTotal && (
        <Field label={`Progress (% — oneshot or unknown chapter count): ${draft.progressPercent || 0}%`}>
          <input type="range" min="0" max="100" value={draft.progressPercent || 0} onChange={setNum("progressPercent")} />
        </Field>
      )}

      <div className="ft-form-grid ft-form-grid-3">
        <Field label="Date started" hint="AO3's Published date"><input type="date" value={draft.dateStarted} onChange={set("dateStarted")} /></Field>
        <Field label="Date finished" hint="AO3's Completed date"><input type="date" value={draft.dateFinished} onChange={set("dateFinished")} /></Field>
        <Field label="Last updated" hint="AO3's Updated date — WIPs only"><input type="date" value={draft.lastUpdated} onChange={set("lastUpdated")} /></Field>
      </div>

      <div className="ft-form-grid">
        <Field label="Read count" hint="how many times you've finished it — bumps automatically each time you hit Mark complete">
          <div className="ft-fetchrow">
            <input type="number" min="0" value={draft.readCount} onChange={setNum("readCount")} />
          </div>
        </Field>
        <Field label="Source">
          <select value={draft.source} onChange={set("source")}>
            {["AO3", "FFN", "Wattpad", "Tumblr", "Other"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Tags / tropes" hint="comma separated — used in Stats"><input value={joinList(draft.tags)} onChange={setListField("tags")} /></Field>

      <Field label="Series" hint="a fic can belong to more than one series, each with its own position">
        {(draft.seriesEntries || []).map((entry, idx) => (
          <div key={idx} className="ft-fetchrow" style={{ marginBottom: 6 }}>
            <input
              placeholder="Series name"
              value={entry.seriesName}
              onChange={(e) =>
                setDraft((d) => {
                  const next = [...(d.seriesEntries || [])];
                  next[idx] = { ...next[idx], seriesName: e.target.value };
                  return { ...d, seriesEntries: next };
                })
              }
              list="ft-series-list"
            />
            <input
              type="number"
              min="1"
              placeholder="#"
              style={{ maxWidth: 70 }}
              value={entry.seriesPosition}
              onChange={(e) =>
                setDraft((d) => {
                  const next = [...(d.seriesEntries || [])];
                  next[idx] = { ...next[idx], seriesPosition: e.target.value === "" ? "" : Number(e.target.value) };
                  return { ...d, seriesEntries: next };
                })
              }
            />
            <button
              type="button"
              className="ft-iconbtn"
              onClick={() =>
                setDraft((d) => ({ ...d, seriesEntries: (d.seriesEntries || []).filter((_, i) => i !== idx) }))
              }
              aria-label="Remove this series"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <datalist id="ft-series-list">{seriesNames.map((s) => <option key={s} value={s} />)}</datalist>
        <button
          type="button"
          className="ft-btn ft-btn-ghost"
          onClick={() => setDraft((d) => ({ ...d, seriesEntries: [...(d.seriesEntries || []), { seriesName: "", seriesPosition: "" }] }))}
        >
          <Plus size={14} /> Add to a series
        </button>
      </Field>

      <Field label="Collections">
        {collections.length > 0 && (
          <div className="ft-checkrow">
            {collections.map((c) => (
              <label key={c.id} className="ft-check">
                <input type="checkbox" checked={(draft.collections || []).includes(c.id)} onChange={() => toggleCollection(c.id)} />
                {c.name}
              </label>
            ))}
          </div>
        )}
        <div className="ft-fetchrow" style={{ marginTop: collections.length > 0 ? 8 : 0 }}>
          <input
            placeholder="New collection name…"
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              e.stopPropagation();
              if (newCollectionName.trim()) createAndAddCollection();
            }}
          />
          <button
            type="button"
            className="ft-btn ft-btn-ghost"
            disabled={!newCollectionName.trim()}
            onClick={createAndAddCollection}
          >
            <Plus size={14} /> Create & add
          </button>
        </div>
      </Field>

      <Field label="This is a rec from a friend">
        <div className="ft-fetchrow">
          <label className="ft-check">
            <input
              type="checkbox"
              checked={draft.addedVia === "rec"}
              onChange={(e) => setDraft((d) => ({ ...d, addedVia: e.target.checked ? "rec" : "self" }))}
            />
            yes
          </label>
          {draft.addedVia === "rec" && (
            <input placeholder="Recommended by… (optional)" value={draft.recommendedBy} onChange={set("recommendedBy")} />
          )}
        </div>
      </Field>

      <Field label="Summary"><textarea rows={2} value={draft.summary} onChange={set("summary")} /></Field>
      <Field label="Your notes"><textarea rows={2} value={draft.notes} onChange={set("notes")} /></Field>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Bulk import panel                                                  */
/* ---------------------------------------------------------------- */

function BulkImportPanel({ payload, existingFics, onClose, onAdd, onSaveSeriesInfoOnly }) {
  const { works, sourceTitle, sourcePage } = payload;
  const isSeriesSource = !!sourceTitle && /\/series\/\d+/.test(sourcePage || "");
  const RATING_MAP = { NR: "Not Rated", G: "General", T: "Teen+", M: "Mature", E: "Explicit" };

  // Pre-check which ones look like duplicates — by AO3 work id where possible (so a
  // chapter-specific link from an older import correctly matches a freshly-scraped
  // canonical link for the same work), falling back to an exact link match for anything
  // that isn't an AO3 url.
  const existingWorkIds = new Set(existingFics.map((f) => ao3WorkId(f.link)).filter(Boolean));
  const existingLinks = new Set(existingFics.map((f) => f.link).filter(Boolean));
  const isExistingDup = (link) => {
    const wid = ao3WorkId(link);
    return wid ? existingWorkIds.has(wid) : existingLinks.has(link);
  };
  const findExistingFic = (link) => {
    const wid = ao3WorkId(link);
    return existingFics.find((f) => (wid ? ao3WorkId(f.link) === wid : f.link === link)) || null;
  };
  const hasStatChanges = (w, existing) =>
    !!existing && (
      (w.wordCount || 0) !== (existing.wordCount || 0) ||
      (w.chapterCurrent || 0) !== (existing.chapterCurrent || 0) ||
      (w.ficStatus || "") !== (existing.ficStatus || "")
    );
  // True when this scrape names a series the existing entry isn't linked to yet — the
  // case that used to silently go nowhere (stats already matched, so nothing looked
  // "changed") and was the actual reason people re-added the fic from the other series'
  // import, creating a real duplicate card instead of just gaining a series link.
  const missingSeriesLink = (w, existing) =>
    !!existing && !!w.seriesName && !(existing.seriesEntries || []).some((e) => e.seriesName === w.seriesName);
  const needsRefresh = (w, existing) => hasStatChanges(w, existing) || missingSeriesLink(w, existing);

  const [refreshChecked, setRefreshChecked] = useState(() => {
    // Default to refreshing every duplicate whose stats changed, or that's missing a
    // series link this scrape has — re-importing a series/fic you're already tracking
    // should update it automatically, not silently leave stale data (or an unlinked
    // series) behind because a checkbox went unticked. You can still uncheck individual
    // rows below if you don't want a particular one touched.
    const s = new Set();
    works.forEach((w, i) => {
      if (isExistingDup(w.link) && needsRefresh(w, findExistingFic(w.link))) s.add(i);
    });
    return s;
  });
  const toggleRefresh = (i) =>
    setRefreshChecked((prev) => {
      const n = new Set(prev);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  const [checked, setChecked] = useState(() => {
    const s = new Set();
    works.forEach((w, i) => { if (!isExistingDup(w.link)) s.add(i); });
    return s;
  });

  const toggle = (i) => setChecked((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const newIndexes = works.map((w, i) => i).filter((i) => !isExistingDup(works[i].link));
  const allChecked = newIndexes.length > 0 && newIndexes.every((i) => checked.has(i));
  // "Select all" means "select all the genuinely new ones" — it deliberately never sweeps in
  // items already flagged as duplicates, since silently re-adding something already in your
  // library (with no further warning) is exactly how this produced duplicate fics before.
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(newIndexes));

  const [markAsRec, setMarkAsRec] = useState(false);
  const [recommendedBy, setRecommendedBy] = useState("");

  const handleAdd = () => {
    const seriesLinks = {}; // seriesName -> AO3 link, collected so the caller can auto-fill new series entries
    // Final safety net: re-verify right here, at the actual moment of commit — not just
    // relying on the pre-check that only set the initial checkbox state. This is what
    // actually prevents a duplicate from being added, regardless of how an item ended up
    // checked (an accidental "Select all" sweep, or manually re-checking a greyed-out row).
    const selectedIndexes = Array.from(checked).filter((i) => !isExistingDup(works[i].link));
    const skippedDupCount = checked.size - selectedIndexes.length;
    const drafts = selectedIndexes.map((i) => {
      const w = works[i];
      if (w.seriesName && w.seriesLink) seriesLinks[w.seriesName] = w.seriesLink;
      return {
        link: w.link || "", source: "AO3",
        title: w.title || "", author: w.author || "",
        fandoms: w.fandoms || [], relationships: w.relationships || [],
        characters: w.characters || [], rating: w.rating || "T",
        warnings: w.warnings || [], wordCount: w.wordCount || 0,
        chapterCurrent: w.chapterCurrent || 0, chapterTotal: normalizeChapterTotal(w.chapterTotal, 1),
        ficStatus: inferFicStatus(w.ficStatus, w.chapterCurrent, w.chapterTotal),
        dateStarted: w.dateStarted || "", dateFinished: w.dateFinished || "",
        lastUpdated: w.lastUpdated || "", summary: w.summary || "",
        tags: w.tags || [],
        seriesEntries: w.seriesName ? [{ seriesName: w.seriesName, seriesPosition: w.seriesPosition ?? "" }] : [],
        notes: "", rating_personal: "", currentChapter: 0, collections: [],
        addedVia: markAsRec ? "rec" : "self",
        recommendedBy: markAsRec ? recommendedBy.trim() : "",
      };
    });
    const refreshes = Array.from(refreshChecked)
      .map((i) => ({ existing: findExistingFic(works[i].link), fresh: works[i] }))
      .filter((r) => r.existing);
    onAdd(drafts, seriesLinks, skippedDupCount, refreshes);
  };

  return (
    <div className="ft-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ft-modal ft-modal-wide" style={{ maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div className="ft-modal-head">
          <h2>Bulk Import{sourceTitle ? ` — ${sourceTitle}` : ""}</h2>
          <button className="ft-iconbtn" onClick={onClose}><X size={16} /></button>
        </div>
        <p className="ft-muted" style={{ padding: "0 18px 8px" }}>
          {works.length} work{works.length !== 1 ? "s" : ""} found.
          {" "}{checked.size} selected to add.
          {" "}{refreshChecked.size > 0 && `${refreshChecked.size} selected to refresh. `}
          Rows already in your library that have changed — including just gaining a series link this scrape has — are pre-checked to refresh; uncheck any you don't want touched.
        </p>
        <div style={{ padding: "0 18px 10px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={markAsRec} onChange={(e) => setMarkAsRec(e.target.checked)} />
            Mark all added fics as recs
          </label>
          {markAsRec && (
            <input
              placeholder="Recommended by… (optional)"
              value={recommendedBy}
              onChange={(e) => setRecommendedBy(e.target.value)}
              style={{ maxWidth: 220 }}
            />
          )}
        </div>
        {works.some((w, i) => needsRefresh(w, isExistingDup(w.link) ? findExistingFic(w.link) : null)) && (
          <div style={{ padding: "0 18px 8px" }}>
            <button
              className="ft-pill"
              onClick={() => {
                const changedIndexes = works.map((w, i) => i).filter((i) =>
                  isExistingDup(works[i].link) && needsRefresh(works[i], findExistingFic(works[i].link))
                );
                setRefreshChecked(new Set(changedIndexes));
              }}
            >
              <RotateCcw size={12} /> Select all that changed
            </button>
          </div>
        )}
        {isSeriesSource && (
          <div style={{ padding: "0 18px 10px" }}>
            <button className="ft-btn ft-btn-ghost" onClick={() => onSaveSeriesInfoOnly(payload)}>
              <Link2 size={14} /> Just save this series' link &amp; description — don't import any fics
            </button>
            <p className="ft-muted" style={{ margin: "4px 0 0", fontSize: 11 }}>
              Useful if you already have all these fics and only opened this page to fix a missing series link.
            </p>
          </div>
        )}
        <div style={{ overflowY: "auto", flex: 1, padding: "0 18px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--c-border)", textAlign: "left" }}>
                <th style={{ padding: "4px 8px 8px 0", width: 28 }}>
                  <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                </th>
                <th style={{ padding: "4px 8px 8px 0" }}>Title</th>
                <th style={{ padding: "4px 8px 8px 0" }}>Author</th>
                <th style={{ padding: "4px 8px 8px 0" }}>Words</th>
                <th style={{ padding: "4px 8px 8px 0" }}>Rating</th>
                <th style={{ padding: "4px 8px 8px 0" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {works.map((w, i) => {
                const isDup = isExistingDup(w.link);
                const existing = isDup ? findExistingFic(w.link) : null;
                const statsChanged = hasStatChanges(w, existing);
                const seriesMissing = missingSeriesLink(w, existing);
                const needsAttention = statsChanged || seriesMissing;
                return (
                  <tr key={i} style={{ opacity: isDup && !needsAttention ? 0.4 : 1, borderBottom: "1px solid var(--c-border)" }}>
                    <td style={{ padding: "5px 8px 5px 0" }}>
                      {isDup ? (
                        <input type="checkbox" checked={refreshChecked.has(i)} onChange={() => toggleRefresh(i)} title="Refresh this fic's stats / series links" />
                      ) : (
                        <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} />
                      )}
                    </td>
                    <td style={{ padding: "5px 8px 5px 0" }}>
                      <a href={w.link} target="_blank" rel="noreferrer" style={{ color: "var(--c-accent)", fontSize: 12 }}>
                        {w.title}
                      </a>
                      {isDup && (
                        <span className="ft-muted" style={{ marginLeft: 6 }}>
                          {statsChanged
                            ? `(in library — ${existing.wordCount || 0} → ${w.wordCount || 0} words${(w.chapterCurrent || 0) !== (existing.chapterCurrent || 0) ? `, ${existing.chapterCurrent || 0}→${w.chapterCurrent || 0} ch.` : ""}${seriesMissing ? `, adds Part ${w.seriesPosition} of ${w.seriesName}` : ""})`
                            : seriesMissing
                            ? `(in library — adds Part ${w.seriesPosition} of ${w.seriesName})`
                            : "(already in library, up to date)"}
                        </span>
                      )}
                      {w.seriesName && <span className="ft-muted" style={{ display: "block", fontSize: 11 }}>Part {w.seriesPosition} of {w.seriesName}</span>}
                    </td>
                    <td style={{ padding: "5px 8px 5px 0", fontSize: 12, color: "var(--c-muted)" }}>{w.author}</td>
                    <td style={{ padding: "5px 8px 5px 0", fontSize: 12, color: "var(--c-muted)", whiteSpace: "nowrap" }}>
                      {w.wordCount ? w.wordCount.toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: "5px 8px 5px 0", fontSize: 11, color: "var(--c-muted)" }}>{RATING_MAP[w.rating] || w.rating || "—"}</td>
                    <td style={{ padding: "5px 8px 5px 0", fontSize: 11, color: "var(--c-muted)" }}>{w.ficStatus || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="ft-modal-foot" style={{ padding: "12px 18px", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="ft-btn ft-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="ft-btn ft-btn-primary" disabled={checked.size === 0 && refreshChecked.size === 0} onClick={handleAdd}>
            <Check size={14} />
            {checked.size > 0 && ` Add ${checked.size}`}
            {checked.size > 0 && refreshChecked.size > 0 && ","}
            {refreshChecked.size > 0 && ` Refresh ${refreshChecked.size}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Main app                                                           */
/* ---------------------------------------------------------------- */

function Tracker({ uid, userEmail, onSignOut }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [trash, setTrash] = useState([]);
  const [fics, setFics] = useState([]);
  const [lists, setLists] = useState({ collections: [], favoriteAuthors: [], series: [] });
  const [tab, setTab] = useState("library");
  useEffect(() => { setGridSelectMode(false); setGridSelected(new Set()); }, [tab]);

  const [search, setSearch] = useState(() => loadUIState().search || "");
  const [filterFandoms, setFilterFandoms] = useState(() => loadUIState().filterFandoms || []);
  const [filterShip, setFilterShip] = useState(() => loadUIState().filterShip || "");
  const [filterReading, setFilterReading] = useState(() => loadUIState().filterReading || "All");
  const [filterFicStatus, setFilterFicStatus] = useState(() => loadUIState().filterFicStatus || "All");
  const [filterRating, setFilterRating] = useState(() => loadUIState().filterRating || "All");
  const [filterWordRange, setFilterWordRange] = useState(() => loadUIState().filterWordRange || "any");
  const [filterOneshotOnly, setFilterOneshotOnly] = useState(() => loadUIState().filterOneshotOnly || false);
  const [filterStandaloneOnly, setFilterStandaloneOnly] = useState(() => loadUIState().filterStandaloneOnly || false);
  const [sortBy, setSortBy] = useState(() => loadUIState().sortBy || "dateAdded_desc");

  const [modal, setModal] = useState(null);
  const [bulkImport, setBulkImport] = useState(null); // { works, sourceTitle, sourcePage } // {mode:'add'|'edit', draft}
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashSelected, setTrashSelected] = useState(new Set());
  const [collectionModal, setCollectionModal] = useState(null);
  const [seriesModal, setSeriesModal] = useState(null);
  const [authorModal, setAuthorModal] = useState(null);
  const [authorFilterName, setAuthorFilterName] = useState(null);

  const hasActiveFilters =
    !!search.trim() ||
    filterFandoms.length > 0 ||
    !!filterShip.trim() ||
    filterReading !== "All" ||
    filterFicStatus !== "All" ||
    filterRating !== "All" ||
    filterWordRange !== "any" ||
    filterOneshotOnly ||
    filterStandaloneOnly ||
    !!authorFilterName;

  const clearAllFilters = () => {
    setSearch("");
    setFilterFandoms([]);
    setFilterShip("");
    setFilterReading("All");
    setFilterFicStatus("All");
    setFilterRating("All");
    setFilterWordRange("any");
    setFilterOneshotOnly(false);
    setFilterStandaloneOnly(false);
    setAuthorFilterName(null);
  };
  const [collapsedSeries, setCollapsedSeries] = useState(() => new Set(loadUIState().collapsedSeries || []));
  const [gridSelectMode, setGridSelectMode] = useState(false);
  const [gridSelected, setGridSelected] = useState(new Set());
  const [seriesSortBy, setSeriesSortBy] = useState(() => loadUIState().seriesSortBy || "name");
  const [showMissingLinks, setShowMissingLinks] = useState(false);
  const [seriesSearch, setSeriesSearch] = useState(() => loadUIState().seriesSearch || "");
  const [collectionSearch, setCollectionSearch] = useState(() => loadUIState().collectionSearch || "");
  const [collectionPicker, setCollectionPicker] = useState(null); // { title, ficIds, selected, newName }
  const [collapsedCollections, setCollapsedCollections] = useState(() => new Set(loadUIState().collapsedCollections || []));
  const toggleCollapsed = (setFn, id) =>
    setFn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Persist UI preferences (filters, sort, what's collapsed) so a refresh leaves things the
  // way you left them. Library data itself is separately synced to Firestore — this is purely
  // local browser state.
  useEffect(() => {
    const state = {
      search, filterFandoms, filterShip, filterReading, filterFicStatus, filterRating,
      filterWordRange, filterOneshotOnly, filterStandaloneOnly, sortBy,
      seriesSortBy, seriesSearch, collectionSearch,
      collapsedSeries: Array.from(collapsedSeries),
      collapsedCollections: Array.from(collapsedCollections),
    };
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
    } catch {
      // localStorage can fail (private browsing, storage full) — not worth surfacing to the user
    }
  }, [
    search, filterFandoms, filterShip, filterReading, filterFicStatus, filterRating,
    filterWordRange, filterOneshotOnly, filterStandaloneOnly, sortBy,
    seriesSortBy, seriesSearch, collectionSearch, collapsedSeries, collapsedCollections,
  ]);

  const [seriesImport, setSeriesImport] = useState(null); // {step, url, seriesName, total, current, added, skipped, failed, error}
  const [seriesImportUrl, setSeriesImportUrl] = useState("");
  const [csvImport, setCsvImport] = useState(null); // {step, total, current, added, tagged, failed, shelves}
  const [jsonImportReview, setJsonImportReview] = useState(null); // { fileFics, fileLists, toAdd, toDeleteCount, mode, confirmReplace }

  // ── State-correctness machinery ──────────────────────────────────────────
  // ficsRef/listsRef always hold the true current value, updated synchronously
  // by persistFics/persistLists — never stale, unlike a closure-captured `fics`.
  // writingRef suppresses the realtime listener while one of our own writes is
  // in flight, so Firestore's echo of our own save can't race ahead of (and
  // overwrite with stale data) a second update made shortly after the first.
  const ficsRef = useRef(fics);
  const listsRef = useRef(lists);
  const writingRef = useRef(0); // counts in-flight writes; >0 means "ignore incoming snapshots"
  useEffect(() => { ficsRef.current = fics; }, [fics]);
  useEffect(() => { listsRef.current = lists; }, [lists]);

  /* ---- load on mount, stay synced in realtime ---- */
  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    // watchLibrary is async now (it awaits a one-time migration check before subscribing),
    // so the cleanup function below can't just return its result directly the way a sync
    // version could — instead it tracks whether we've already unmounted by the time the
    // subscription is actually established, and tears it down immediately if so.
    watchLibrary(uid, (data) => {
      if (cancelled) return;
      if (writingRef.current > 0) return; // a persistFics/persistLists call is still in flight — trust local state
      const nextFics = (data.fics || []).map(normalizeFic);
      setFics(nextFics);
      ficsRef.current = nextFics;
      setLists(data.lists);
      listsRef.current = data.lists;
      setLoaded(true);
      setLoadError(null);
    }, (err) => {
      if (cancelled) return;
      setLoadError(err?.message || String(err));
    }).then((unsub) => {
      if (cancelled) unsub();
      else unsubscribe = unsub;
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [uid]);

  /* ---- trash: realtime subscription + one-time auto-purge of anything past 30 days ---- */
  const trashPurgeChecked = useRef(false);
  useEffect(() => {
    const unsubscribe = watchTrash(uid, (items) => {
      setTrash(items);
      // Run the client-side expiry sweep once per load, after the first real snapshot —
      // this is a fallback for whenever a server-side Firestore TTL policy isn't
      // configured (see firebase.js), so trash still empties itself out even without
      // that extra setup, just only when someone has the app open to trigger the check.
      if (!trashPurgeChecked.current) {
        trashPurgeChecked.current = true;
        purgeExpiredTrash(uid, items, 30).catch((e) => console.error("trash purge failed", e));
      }
    });
    return unsubscribe;
  }, [uid]);

  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- undo: an in-memory (not persisted — resets on reload, which is fine for "I just
  // made a mistake") stack of recent library-changing actions. Every persistFics call
  // pushes one automatically (see persistFics below); undoing one reverts exactly that
  // diff — restoring anything it removed from trash, putting changed fics back to their
  // prior values, and removing anything it added (which itself routes back through
  // persistFics, so even an undone addition is trash-recoverable, not a hard delete).
  const MAX_UNDO = 20;
  const [undoStack, setUndoStack] = useState([]);
  const undoStackRef = useRef([]);
  const [undoOpen, setUndoOpen] = useState(false);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const pushUndo = useCallback((entry) => {
    const next = [entry, ...undoStackRef.current].slice(0, MAX_UNDO);
    undoStackRef.current = next;
    setUndoStack(next);
  }, []);

  /* ---- handle the "Add to Library" bookmarklet's ?add=<url> param ----
     Opens the Add modal immediately with the link filled in, then tells FicForm to run
     its own "Fetch details" automatically (same fetchState loading/error/locked UI you
     already see when pasting a link manually) — so there's visible feedback right away
     instead of a silent wait while AO3 (and our retry logic) does its thing in the
     background. The previous version waited for the fetch to finish before opening the
     modal at all, which on a slow/overloaded AO3 response looked like nothing happened. */
  const addProcessed = useRef(false);
  useEffect(() => {
    if (!loaded || addProcessed.current) return;
    const params = new URLSearchParams(window.location.search);
    const addLink = params.get("add"); // URLSearchParams already URL-decodes this
    if (!addLink) return;
    addProcessed.current = true;

    setModal({
      mode: "add",
      draft: { ...emptyFic(), link: addLink, source: detectSource(addLink) },
      autoFetch: true,
    });

    params.delete("add");
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl);
  }, [loaded, fics]);

  /* ---- handle the DOM-scraping bookmarklet's ?addData=<base64 json> param ----
     The bookmarklet already read every field straight off the AO3 page in your browser, so
     there's no fetch to wait on here at all — just decode and open the form pre-filled. */
  const addDataProcessed = useRef(false);
  useEffect(() => {
    if (!loaded || addDataProcessed.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("addData")) return; // param not present at all — nothing to do, stay quiet
    const addData = params.get("addData");
    addDataProcessed.current = true;

    if (!addData) {
      // Param was present but empty — the Shortcut/bookmarklet ran but didn't actually
      // produce any data, which used to fail completely silently here.
      setToast({ kind: "warn", text: "That import link didn't include any fic data — try sharing the page again, and make sure it fully loaded first." });
      params.delete("addData");
      window.history.replaceState({}, "", window.location.pathname + (params.toString() ? `?${params.toString()}` : ""));
      return;
    }

    try {
      const json = decodeURIComponent(escape(atob(addData)));
      const parsed = JSON.parse(json);
      const seriesEntries = (parsed.seriesList && parsed.seriesList.length > 0)
        ? parsed.seriesList.map((s) => ({ seriesName: s.name, seriesPosition: s.position ?? "" }))
        : (parsed.seriesName ? [{ seriesName: parsed.seriesName, seriesPosition: parsed.seriesPosition ?? "" }] : []);

      // For any series this fic belongs to: create a lists.series entry (with the link
      // already filled in) if there's none yet, or patch the link onto an entry that
      // already exists but is missing one (e.g. one auto-created earlier via "Mark
      // complete" or a JSON import that never carried links) — never overwrites a link
      // that's already there.
      if (parsed.seriesList && parsed.seriesList.length > 0) {
        parsed.seriesList.forEach((s) => createOrPatchSeries(s.name, { link: s.link }));
      }
      const draft = {
        ...emptyFic(),
        link: parsed.link || "",
        source: detectSource(parsed.link || ""),
        title: parsed.title || "",
        author: parsed.author || "",
        fandoms: parsed.fandoms || [],
        relationships: parsed.relationships || [],
        characters: parsed.characters || [],
        rating: parsed.rating || "T",
        warnings: parsed.warnings || [],
        wordCount: parsed.wordCount ?? 0,
        chapterCurrent: parsed.chapterCurrent ?? 0,
        chapterTotal: normalizeChapterTotal(parsed.chapterTotal, 1),
        ficStatus: inferFicStatus(parsed.ficStatus, parsed.chapterCurrent, parsed.chapterTotal),
        dateStarted: parsed.dateStarted || "",
        dateFinished: parsed.dateFinished || "",
        lastUpdated: parsed.lastUpdated || "",
        summary: parsed.summary || "",
        tags: parsed.tags || [],
        seriesEntries,
      };
      setModal({ mode: "add", draft });
      setToast({ kind: "ok", text: "Pulled details straight from the AO3 page — review and save below." });
    } catch (e) {
      console.error("Couldn't parse bookmarklet data", e);
      setToast({ kind: "warn", text: "Couldn't read the data from that bookmarklet click — try again, or paste the link in manually." });
    }

    params.delete("addData");
    const cleanUrl2 = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl2);
  }, [loaded, fics]);

  /* ---- handle the bulk DOM-scraping bookmarklet's ?addBulk=<base64 json> param ---- */
  useEffect(() => {
    if (!loaded) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("addBulk")) return;
    const addBulk = params.get("addBulk");

    params.delete("addBulk");
    const cleanUrl3 = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl3);

    if (!addBulk) {
      setToast({ kind: "warn", text: "That import link didn't include any fic data — try sharing the page again, and make sure it fully loaded first." });
      return;
    }

    try {
      const json = decodeURIComponent(escape(atob(addBulk)));
      const payload = JSON.parse(json);
      const works = (payload.works || []).filter((w) => w.title && w.link);
      if (works.length > 0) {
        setBulkImport({ works, sourceTitle: payload.sourceTitle || "", sourcePage: payload.sourcePage || "", sourceCompleted: payload.sourceCompleted ?? null, sourceDescription: payload.sourceDescription || "" });
      } else {
        setToast({ kind: "warn", text: "No works found in that bulk import payload." });
      }
    } catch (e) {
      console.error("Couldn't parse bulk bookmarklet data", e);
      setToast({ kind: "warn", text: "Couldn't read bulk import data — try again." });
    }
  }, [loaded]);

  // Both accept either a plain array/object (old call sites) or an updater function
  // (prev) => next (preferred — guarantees correctness when calls happen in quick
  // succession, since `prev` always comes from ficsRef.current, never a stale closure).
  // Use this specifically when ADDING new fics (single add, bulk import, CSV import,
  // series/collection import) — these are the operations most likely to run from a
  // freshly-opened tab (the bookmarklets each open a new tab) whose local snapshot may
  // be a beat behind another tab's recent write. appendFics is transaction-safe against
  // that; persistFics (full-array overwrite) is not, and is fine for edits/deletes/status
  // changes made within an already-loaded, already-synced tab.
  // persistFics now diffs the computed `next` state against ficsRef.current and writes
  // only the fics that actually changed (added, edited, or removed) as small individual
  // Firestore documents — see saveFicsDiff / the per-fic-document migration in
  // firebase.js. Every existing call site keeps working exactly as before
  // (persistFics((prev) => ...) or persistFics(value)); only the persistence underneath
  // changed, from "rewrite the whole library every time" to "touch only what changed".
  const persistFics = useCallback(async (updaterOrValue, opts = {}) => {
    const prev = ficsRef.current;
    let next = typeof updaterOrValue === "function" ? updaterOrValue(prev) : updaterOrValue;

    const prevById = new Map(prev.map((f) => [f.id, f]));

    // Stamp any fic that's new or actually changed with when it was last touched — status
    // changes, edits, progress updates, imports, all count. Powers the "Recently interacted"
    // sort. Skipped when reverting via undo, since restoring old values isn't a fresh
    // interaction with the fic — it should keep whatever timestamp it had before the change
    // being undone.
    if (!opts.skipUndo) {
      const now = new Date().toISOString();
      next = next.map((f) => {
        const old = prevById.get(f.id);
        return !old || old !== f ? { ...f, lastInteractedAt: now } : f;
      });
    }

    ficsRef.current = next;
    setFics(next);

    const nextById = new Map(next.map((f) => [f.id, f]));

    const upserts = [];
    for (const [id, fic] of nextById) {
      if (!id) continue; // shouldn't happen — every fic gets an id on creation — but don't crash if it does
      const old = prevById.get(id);
      if (!old || old !== fic) upserts.push(fic); // reference inequality = new or changed
    }
    const removedFics = [];
    for (const [id, fic] of prevById) {
      if (!nextById.has(id)) removedFics.push(fic);
    }

    if (upserts.length === 0 && removedFics.length === 0) return; // nothing actually changed

    // Classify each upsert as a brand-new fic (wasn't in prev — undo removes it) or an
    // edit to an existing one (undo restores its prior values) — then record the whole
    // diff as one undo-able entry, unless this call is itself a revert (skipUndo), to
    // avoid an undo creating its own undoable "undo the undo" noise in the stack.
    if (!opts.skipUndo) {
      const added = [];
      const changed = [];
      for (const fic of upserts) {
        const old = prevById.get(fic.id);
        if (old) changed.push({ id: fic.id, prevFic: old });
        else added.push(fic.id);
      }
      const parts = [];
      if (added.length === 1) parts.push(`added "${truncateTitle(upserts.find((u) => u.id === added[0])?.title)}"`);
      else if (added.length > 1) parts.push(`added ${added.length} fics`);
      if (changed.length === 1) parts.push(`updated "${truncateTitle(changed[0].prevFic.title)}"`);
      else if (changed.length > 1) parts.push(`updated ${changed.length} fics`);
      if (removedFics.length === 1) parts.push(`deleted "${truncateTitle(removedFics[0].title)}"`);
      else if (removedFics.length > 1) parts.push(`deleted ${removedFics.length} fics`);
      pushUndo({
        id: genId(),
        ts: Date.now(),
        label: opts.label || parts.join(", ") || "Library change",
        added,
        changed,
        removed: removedFics,
      });
    }

    writingRef.current += 1;
    try {
      await saveFicsDiff(uid, upserts, removedFics);
    } catch (e) {
      console.error("save fics failed", e);
      ficsRef.current = prev;
      setFics(prev);
      setToast({ kind: "warn", text: `Couldn't save that change — ${e?.message || "save failed"}. Try again.` });
    } finally {
      writingRef.current -= 1;
    }
  }, [uid, pushUndo]);

  // Kept as a separate name since call sites already use it to document intent ("these
  // are brand new") — it's now just a thin wrapper over the same diffing persistFics,
  // since prepending new fics to `prev` is exactly the kind of change persistFics already
  // detects and writes correctly (as upserts, since their ids won't be in prevById).
  const persistFicsAppend = useCallback((newFics) => persistFics((prev) => [...newFics, ...prev]), [persistFics]);

  /* ---- handle the reading-progress bookmarklet's ?updateProgress=<base64 json> param ----
     Unlike add/addBulk, this applies directly with no review step — it's just "which
     chapter am I on", low-risk and annoying to have to confirm every time you read. */
  useEffect(() => {
    if (!loaded) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("updateProgress")) return;
    const raw = params.get("updateProgress");

    params.delete("updateProgress");
    const cleanUrl4 = window.location.pathname + (params.toString() ? `?${params.toString()}` : "");
    window.history.replaceState({}, "", cleanUrl4);

    if (!raw) {
      setToast({ kind: "warn", text: "That progress-update link didn't include any data — try again from AO3." });
      return;
    }

    try {
      const json = decodeURIComponent(escape(atob(raw)));
      const data = JSON.parse(json);
      const match = findDuplicate({ link: data.link || "" }, ficsRef.current, null);
      if (!match) {
        setToast({ kind: "warn", text: "That fic isn't in your library yet — add it first, then update progress." });
        return;
      }
      const hasChapterNum = data.chapterNumber !== undefined && data.chapterNumber !== null;
      const chapterNum = hasChapterNum
        ? Math.max(0, Math.min(data.chapterNumber, match.chapterCurrent || data.chapterNumber || 0))
        : (match.readChapter || 0); // couldn't detect a chapter number on AO3's page — leave progress as-is
      persistFics((prev) =>
        prev.map((f) => {
          if (f.id !== match.id) return f;
          const patch = { lastReadUrl: data.chapterUrl || f.lastReadUrl };
          if (hasChapterNum) patch.readChapter = chapterNum;
          // Only auto-promote to Currently Reading from a resting state — don't override
          // Caught Up/Completed/Abandoned/On Hold just because a progress link got clicked.
          if (f.readingStatus === "Unread") patch.readingStatus = "Currently Reading";
          return { ...f, ...patch };
        })
      );
      setToast({
        kind: hasChapterNum ? "ok" : "warn",
        text: hasChapterNum
          ? `Updated "${truncateTitle(match.title)}" to chapter ${chapterNum}.`
          : `Saved your spot in "${truncateTitle(match.title)}", but couldn't detect the chapter number — check it's still right.`,
        undoIds: undoStackRef.current[0] ? [undoStackRef.current[0].id] : [],
      });
    } catch (e) {
      console.error("Couldn't parse progress-update data", e);
      setToast({ kind: "warn", text: "Couldn't read that progress update — try again." });
    }
  }, [loaded, persistFics]);

  const persistLists = useCallback(async (updaterOrValue) => {
    const next = typeof updaterOrValue === "function" ? updaterOrValue(listsRef.current) : updaterOrValue;
    listsRef.current = next;
    setLists(next);
    writingRef.current += 1;
    try {
      await saveLists(uid, next);
    } catch (e) {
      console.error("save lists failed", e);
    } finally {
      writingRef.current -= 1;
    }
  }, [uid]);

  /* ---- fic CRUD ---- */
  const openAdd = () => setModal({ mode: "add", draft: emptyFic() });
  const openEdit = (fic) => setModal({ mode: "edit", draft: { ...fic } });

  // Merges freshly-scraped AO3 data onto an existing fic — used when the bookmarklet (or
  // manual "fetch details") finds you're already tracking this fic, turning what used to
  // be a dead-end duplicate warning into an actual "refresh this fic's stats" action.
  // Only AO3-sourced fields get overwritten (word count, chapters posted, summary, tags,
  // etc.) — everything you own personally (reading status/progress, notes, collections,
  // when you added it) is left exactly as it was.
  const refreshFicWithFreshData = (existing, fresh) => {
    // `fresh` is either a FicForm draft (seriesEntries array — manual edit/single add) or
    // a raw AO3 scrape (singular seriesName/seriesPosition — bulk bookmarklet). Normalize
    // to an array either way, then merge rather than overwrite, so refreshing a fic you
    // already track from Series A — while importing Series B — adds Series B to its
    // memberships instead of leaving it unlinked (which is what was causing people to
    // re-add the fic from Series B's import and end up with a genuine duplicate card).
    const freshSeriesEntries = fresh.seriesEntries || (fresh.seriesName ? [{ seriesName: fresh.seriesName, seriesPosition: fresh.seriesPosition ?? "" }] : []);
    return {
      ...existing,
      title: fresh.title || existing.title,
      author: fresh.author || existing.author,
      fandoms: fresh.fandoms?.length ? fresh.fandoms : existing.fandoms,
      relationships: fresh.relationships?.length ? fresh.relationships : existing.relationships,
      characters: fresh.characters?.length ? fresh.characters : existing.characters,
      rating: fresh.rating || existing.rating,
      warnings: fresh.warnings?.length ? fresh.warnings : existing.warnings,
      wordCount: fresh.wordCount ?? existing.wordCount,
      chapterCurrent: fresh.chapterCurrent ?? existing.chapterCurrent,
      chapterTotal: normalizeChapterTotal(fresh.chapterTotal, existing.chapterTotal),
      ficStatus: fresh.ficStatus || existing.ficStatus,
      dateFinished: fresh.dateFinished || existing.dateFinished,
      lastUpdated: fresh.lastUpdated || existing.lastUpdated,
      summary: fresh.summary || existing.summary,
      tags: fresh.tags?.length ? fresh.tags : existing.tags,
      seriesEntries: mergeSeriesEntries(existing.seriesEntries, freshSeriesEntries),
    };
  };

  const saveFromModal = () => {
    const d = modal.draft;
    if (!d.title.trim()) return;
    const dup = findDuplicate(d, fics, modal.mode === "edit" ? d.id : null);
    if (dup && modal.mode === "add") return; // only block creating a brand-new duplicate — editing an existing entry can't create one
    if (modal.mode === "add") {
      persistFicsAppend([d]);
    } else {
      persistFics((prev) => prev.map((f) => (f.id === d.id ? d : f)));
    }
    setToast({
      kind: "ok",
      text: modal.mode === "add" ? `Added "${truncateTitle(d.title)}".` : `Saved changes to "${truncateTitle(d.title)}".`,
      undoIds: undoStackRef.current[0] ? [undoStackRef.current[0].id] : [],
    });
    setModal(null);
  };

  const deleteFic = (id) => {
    if (confirmDeleteId === id) {
      persistFics((prev) => prev.filter((f) => f.id !== id));
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId((cur) => (cur === id ? null : cur)), 3000);
    }
  };

  /* ---- trash: restore brings fics straight back into the live library; permanent delete
     is the one true point of no return in the whole app ---- */
  const restoreTrashFics = async (ficIds) => {
    const idSet = new Set(ficIds);
    const now = new Date().toISOString();
    const items = trash.filter((f) => idSet.has(f.id)).map((f) => ({ ...f, lastInteractedAt: now }));
    if (items.length === 0) return;
    writingRef.current += 1;
    try {
      await restoreFromTrash(uid, items);
      // Optimistic local update so it doesn't wait on the next snapshot to feel restored.
      const cleaned = items.map(({ deletedAt, ...rest }) => normalizeFic(rest));
      const nextFics = [...cleaned, ...ficsRef.current];
      ficsRef.current = nextFics;
      setFics(nextFics);
      setTrash((prev) => prev.filter((f) => !idSet.has(f.id)));
      setToast({ kind: "ok", text: `Restored ${items.length} fic${items.length !== 1 ? "s" : ""}.` });
    } catch (e) {
      console.error("restore from trash failed", e);
      setToast({ kind: "warn", text: `Couldn't restore — ${e?.message || "try again"}.` });
    } finally {
      writingRef.current -= 1;
    }
  };

  const permanentDeleteTrashFics = async (ficIds) => {
    if (ficIds.length === 0) return;
    if (!confirm(`Permanently delete ${ficIds.length} fic${ficIds.length !== 1 ? "s" : ""}? This cannot be undone — there's no further recovery after this.`)) return;
    try {
      await permanentlyDeleteTrash(uid, ficIds);
      setTrash((prev) => prev.filter((f) => !ficIds.includes(f.id)));
      setToast({ kind: "ok", text: `Permanently deleted ${ficIds.length} fic${ficIds.length !== 1 ? "s" : ""}.` });
    } catch (e) {
      console.error("permanent delete failed", e);
      setToast({ kind: "warn", text: `Couldn't delete — ${e?.message || "try again"}.` });
    }
  };

  /* ---- undo: reverts exactly one recorded entry's diff ---- */
  const undoEntry = useCallback(async (entryId) => {
    const entry = undoStackRef.current.find((e) => e.id === entryId);
    if (!entry) return;
    // Pull it off the stack right away so a slow network (or a double-click) can't apply
    // the same revert twice.
    const remaining = undoStackRef.current.filter((e) => e.id !== entryId);
    undoStackRef.current = remaining;
    setUndoStack(remaining);

    try {
      if (entry.removed.length > 0) {
        writingRef.current += 1;
        try {
          await restoreFromTrash(uid, entry.removed);
          // Optimistic local update, same as restoreTrashFics — don't wait on the next
          // snapshot for it to feel instant.
          const idSet = new Set(entry.removed.map((f) => f.id));
          const cleaned = entry.removed.map((f) => normalizeFic(f));
          const nextFics = [...cleaned, ...ficsRef.current.filter((f) => !idSet.has(f.id))];
          ficsRef.current = nextFics;
          setFics(nextFics);
          setTrash((prev) => prev.filter((f) => !idSet.has(f.id)));
        } finally {
          writingRef.current -= 1;
        }
      }
      if (entry.added.length > 0 || entry.changed.length > 0) {
        const addedSet = new Set(entry.added);
        const changedMap = new Map(entry.changed.map((c) => [c.id, c.prevFic]));
        // skipUndo — this is the revert itself, not a new undoable action.
        await persistFics(
          (prev) => prev.filter((f) => !addedSet.has(f.id)).map((f) => (changedMap.has(f.id) ? changedMap.get(f.id) : f)),
          { skipUndo: true }
        );
      }
      setToast({ kind: "ok", text: `Undid: ${entry.label}.` });
    } catch (e) {
      console.error("undo failed", e);
      setToast({ kind: "warn", text: `Couldn't undo that — ${e?.message || "try again"}.` });
      // Put it back so they can retry.
      undoStackRef.current = [entry, ...undoStackRef.current];
      setUndoStack(undoStackRef.current);
    }
  }, [uid, persistFics]);

  /* ---- duplicates: merge a cluster down to one entry, keeping the picked one's reading
     progress/notes/status and folding in the others' series links, collections, and tags
     so nothing gets lost — the others go to Trash, same as any other delete. ---- */
  const mergeDuplicatesInto = (keepId, removeIds) => {
    const keep = ficsRef.current.find((f) => f.id === keepId);
    const removed = removeIds.map((id) => ficsRef.current.find((f) => f.id === id)).filter(Boolean);
    if (!keep || removed.length === 0) return;
    let seriesEntries = keep.seriesEntries || [];
    const collections = new Set(keep.collections || []);
    const tags = new Set(keep.tags || []);
    removed.forEach((r) => {
      seriesEntries = mergeSeriesEntries(seriesEntries, r.seriesEntries || []);
      (r.collections || []).forEach((c) => collections.add(c));
      (r.tags || []).forEach((t) => tags.add(t));
    });
    const merged = { ...keep, seriesEntries, collections: Array.from(collections), tags: Array.from(tags) };
    const removeSet = new Set(removeIds);
    persistFics((prev) => prev.filter((f) => !removeSet.has(f.id)).map((f) => (f.id === keepId ? merged : f)));
    setToast({
      kind: "ok",
      text: `Merged ${removed.length} duplicate${removed.length !== 1 ? "s" : ""} into "${truncateTitle(keep.title)}".`,
      undoIds: undoStackRef.current[0] ? [undoStackRef.current[0].id] : [],
    });
  };

  // Mark complete bumps readCount by one (every completion counts, not just rereads) and
  // syncs chapter progress to match the total. Read again (Currently Reading on an
  // already-read fic) resets chapter progress to 1. Neither touches dateStarted/dateFinished —
  // those track the fic's own AO3 publish/completion dates, not your personal reading
  // timeline, so they only ever come from the AO3 fetch or manual entry.
  const quickStatus = (id, status) => {
    const fic = ficsRef.current.find((f) => f.id === id);
    persistFics((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const patch = { readingStatus: status };
        if (status === "Unread") {
          patch.readChapter = 0;
          patch.lastReadUrl = ""; // no progress to speak of — nothing to "continue" from
        }
        if (status === "Currently Reading" && (f.readCount || 0) > 0) {
          patch.readChapter = 1; // Read again — restart from the top
          patch.lastReadUrl = f.link; // ...and "continue reading" should also start over, not jump back to wherever the last read-through left off
        }
        if (status === "Caught Up") {
          patch.readChapter = f.chapterCurrent || 0; // caught up on everything posted so far — doesn't bump readCount, since the fic itself isn't done
          // lastReadUrl deliberately untouched — stays on whatever chapter you last updated
          // progress to, so "continue reading" still lands you at the latest chapter when
          // the fic updates, instead of resetting to the top like a real completion does.
        }
        if (status === "Completed") {
          patch.readChapter = f.chapterCurrent || 0; // caught up on everything posted so far
          patch.readCount = (f.readCount || 0) + 1;
          patch.lastReadUrl = f.link; // done — "continue reading" (a reread) should start back at chapter 1, not the last chapter of the previous read
        }
        return { ...f, ...patch };
      })
    );
    if (fic) {
      setToast({ kind: "ok", text: `Marked "${truncateTitle(fic.title)}" as ${status}.`, undoIds: undoStackRef.current[0] ? [undoStackRef.current[0].id] : [] });
    }
  };

  // Same patching rules as quickStatus, applied to many fics in a single write — used by
  // every "mark read/unread" bulk-select action (Library, Recs, Series, Collections).
  const bulkMarkStatus = (ficIds, status) => {
    const idSet = new Set(ficIds);
    persistFics((prev) =>
      prev.map((f) => {
        if (!idSet.has(f.id)) return f;
        const patch = { readingStatus: status };
        if (status === "Unread") {
          patch.readChapter = 0;
          patch.lastReadUrl = "";
        }
        if (status === "Currently Reading" && (f.readCount || 0) > 0) {
          patch.readChapter = 1;
          patch.lastReadUrl = f.link;
        }
        if (status === "Caught Up") {
          patch.readChapter = f.chapterCurrent || 0;
        }
        if (status === "Completed") {
          patch.readChapter = f.chapterCurrent || 0;
          patch.readCount = (f.readCount || 0) + 1;
          patch.lastReadUrl = f.link;
        }
        return { ...f, ...patch };
      })
    );
    setToast({ kind: "ok", text: `Marked ${ficIds.length} fic${ficIds.length !== 1 ? "s" : ""} as ${status}.`, undoIds: undoStackRef.current[0] ? [undoStackRef.current[0].id] : [] });
  };

  /* ---- collections / authors ---- */
  const saveCollection = (c) => {
    const exists = lists.collections.some((x) => x.id === c.id);
    if (!exists) {
      const dup = lists.collections.find((x) => x.name.trim().toLowerCase() === c.name.trim().toLowerCase());
      if (dup) {
        setCollectionModal(null); // already exists — nothing new to create
        return;
      }
    }
    persistLists((prev) => ({
      ...prev,
      collections: prev.collections.some((x) => x.id === c.id)
        ? prev.collections.map((x) => (x.id === c.id ? c : x))
        : [...prev.collections, c],
    }));
    setCollectionModal(null);
  };
  const quickCreateCollection = (name) => {
    const existing = lists.collections.find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (existing) return existing;
    const c = { id: genId(), name, description: "" };
    persistLists((prev) => ({ ...prev, collections: [...prev.collections, c] }));
    return c;
  };
  const deleteCollection = (id) => {
    const target = lists.collections.find((c) => c.id === id);
    const affected = fics.filter((f) => (f.collections || []).includes(id));
    if (
      affected.length > 0 &&
      !confirm(`Delete "${target?.name || "this collection"}" and remove ${affected.length} fic${affected.length !== 1 ? "s" : ""} from your library? This can't be undone.`)
    ) {
      return;
    }
    persistLists((prev) => ({ ...prev, collections: prev.collections.filter((c) => c.id !== id) }));
    persistFics((prev) => prev.filter((f) => !(f.collections || []).includes(id)));
  };
  // Non-destructive: strips this collection's id off the selected fics' `collections` array
  // without touching the fics themselves at all.
  const removeFromCollection = (collectionId, ficIds) => {
    const idSet = new Set(ficIds);
    persistFics((prev) => prev.map((f) => (idSet.has(f.id) ? { ...f, collections: (f.collections || []).filter((c) => c !== collectionId) } : f)));
  };
  // Move selected fics from fromCollectionId to toCollectionId (adds toId, removes fromId)
  const moveToCollection = (fromCollectionId, toCollectionId, ficIds) => {
    const idSet = new Set(ficIds);
    persistFics((prev) => prev.map((f) => {
      if (!idSet.has(f.id)) return f;
      const cols = f.collections || [];
      const next = cols.filter((c) => c !== fromCollectionId);
      if (!next.includes(toCollectionId)) next.push(toCollectionId);
      return { ...f, collections: next };
    }));
  };

  const runCsvImport = async (file) => {
    setCsvImport({ step: "parsing" });
    let rows;
    try {
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      rows = parsed.data.filter((r) => pickField(r, ["link", "url"]));
    } catch {
      setCsvImport({ step: "error", error: "Couldn't read that file — make sure it's a .csv." });
      return;
    }
    if (rows.length === 0) {
      setCsvImport({ step: "error", error: "Couldn't find any rows with a link/url column in that file." });
      return;
    }

    let workingFics = ficsRef.current;
    const newFics = [];
    let tagged = 0;
    const taggedFicIds = []; // ids of existing fics that got a new collection tag added
    const failed = [];
    const shelfCollectionIds = {};
    const getShelfId = (name) => {
      if (!name) return null;
      if (shelfCollectionIds[name]) return shelfCollectionIds[name];
      const existing = lists.collections.find((c) => c.name.toLowerCase() === name.toLowerCase());
      const id = existing ? existing.id : genId();
      shelfCollectionIds[name] = id;
      return id;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      setCsvImport({ step: "importing", total: rows.length, current: i + 1 });
      const url = pickField(row, ["link", "url"]);
      if (!/\/works\/\d+/.test(url)) { failed.push({ url, reason: "not a work link" }); continue; }

      const shelfName = pickField(row, ["source", "shelf", "status", "readingstatus"]);
      const csvTitle = pickField(row, ["title"]);
      const csvAuthor = pickField(row, ["authors", "author"]);
      const csvFandoms = (pickField(row, ["fandoms", "fandom"]) || "").split(";").map((s) => s.trim()).filter(Boolean);
      const csvRelationships = (pickField(row, ["relationships", "relationship"]) || "").split(";").map((s) => s.trim()).filter(Boolean);
      const csvCharacters = (pickField(row, ["characters", "character"]) || "").split(";").map((s) => s.trim()).filter(Boolean);
      const csvFreeforms = (pickField(row, ["freeforms", "tags", "additional tags"]) || "").split(";").map((s) => s.trim()).filter(Boolean);
      const csvWarnings = (pickField(row, ["warnings", "warning"]) || "").split(";").map((s) => s.trim()).filter(Boolean);
      const csvRating = parseCsvRating(pickField(row, ["rating"]));
      const csvWordNum = (() => { const v = pickField(row, ["wordcount", "words"]); return v ? Number(String(v).replace(/[^\d]/g, "")) || 0 : 0; })();
      const { current: csvChCurrent, total: csvChTotal } = parseChaptersText(pickField(row, ["chapters"]));
      const csvSummary = pickField(row, ["summary"]);
      const csvBlurbDate = pickField(row, ["blurbdate", "date"]);
      const csvSeriesName = pickField(row, ["series", "seriesname", "series name"]);
      const csvSeriesPos = pickField(row, ["seriesposition", "series position", "part"]);

      if (!csvTitle) { failed.push({ url, reason: "no title in CSV row" }); continue; }

      const shelfId = getShelfId(shelfName);
      const dup = findDuplicate({ link: url, title: csvTitle, author: csvAuthor }, [...workingFics, ...newFics]);
      if (dup) {
        const cols = new Set(dup.collections || []);
        if (shelfId && !cols.has(shelfId)) {
          const updated = { ...dup, collections: Array.from(new Set([...cols, shelfId])) };
          workingFics = workingFics.map((f) => (f.id === dup.id ? updated : f));
          taggedFicIds.push(dup.id);
        }
        tagged++;
        continue;
      }

      const ficStatus = csvChTotal
        ? (csvChCurrent === csvChTotal ? "Complete" : "WIP")
        : (pickField(row, ["ficstatus", "status", "complete"]) || "WIP");
      const lastUpdated = ficStatus === "WIP" && csvBlurbDate
        ? (() => { const d = new Date(csvBlurbDate); return isNaN(d) ? "" : d.toISOString().slice(0, 10); })()
        : "";

      newFics.push({
        ...emptyFic(),
        id: genId(),
        dateAdded: today(),
        link: url,
        source: "AO3",
        title: csvTitle,
        author: csvAuthor,
        fandoms: csvFandoms,
        relationships: csvRelationships,
        characters: csvCharacters,
        rating: csvRating || "T",
        warnings: csvWarnings,
        wordCount: csvWordNum,
        chapterCurrent: csvChCurrent ?? 0,
        chapterTotal: normalizeChapterTotal(csvChTotal, 1),
        ficStatus,
        lastUpdated,
        summary: csvSummary,
        tags: csvFreeforms,
        readingStatus: statusFromShelfName(shelfName),
        readChapter: statusFromShelfName(shelfName) === "Completed" ? (csvChCurrent ?? 0) : 0,
        seriesEntries: csvSeriesName ? [{ seriesName: csvSeriesName, seriesPosition: csvSeriesPos || "" }] : [],
        collections: shelfId ? [shelfId] : [],
      });
    }

    const csvUndoIds = [];
    if (newFics.length > 0) {
      persistFicsAppend(newFics);
      if (undoStackRef.current[0]) csvUndoIds.push(undoStackRef.current[0].id);
    }
    if (taggedFicIds.length > 0) {
      const taggedSet = new Set(taggedFicIds);
      persistFics((prev) =>
        prev.map((f) => {
          if (!taggedSet.has(f.id)) return f;
          const fromWorking = workingFics.find((w) => w.id === f.id);
          return fromWorking ? { ...f, collections: fromWorking.collections } : f;
        })
      );
      if (undoStackRef.current[0]) csvUndoIds.push(undoStackRef.current[0].id);
    }
    persistLists((prev) => {
      const existingIds = new Set(prev.collections.map((c) => c.id));
      const newCollections = Object.entries(shelfCollectionIds)
        .filter(([, id]) => !existingIds.has(id))
        .map(([name, id]) => ({ id, name, description: "Imported from a CSV shelf export." }));
      return newCollections.length > 0 ? { ...prev, collections: [...prev.collections, ...newCollections] } : prev;
    });

    setCsvImport({ step: "done", added: newFics.length, tagged, failed, shelves: Object.keys(shelfCollectionIds), undoIds: csvUndoIds });
  };


  const saveSeriesItem = (s) => {
    const { originalName, ...seriesData } = s; // originalName is a transient hint, not part of the saved series object
    persistLists((prev) => ({
      ...prev,
      series: prev.series.some((x) => x.id === seriesData.id)
        ? prev.series.map((x) => (x.id === seriesData.id ? seriesData : x))
        : [...prev.series, seriesData],
    }));

    // The Series tab's list of series names is derived from each fic's own seriesEntries —
    // not from this metadata entry — so renaming only the metadata here would leave every
    // fic still pointing at the old name (which would keep showing up as its own series),
    // while the new name would appear as a separate, empty one. Cascade the rename across
    // every fic that actually references the old name to fix that.
    if (originalName && originalName !== seriesData.name) {
      persistFics((prev) =>
        prev.map((f) => {
          const entries = f.seriesEntries || [];
          if (!entries.some((e) => e.seriesName === originalName)) return f;
          return {
            ...f,
            seriesEntries: entries.map((e) => (e.seriesName === originalName ? { ...e, seriesName: seriesData.name } : e)),
          };
        })
      );
    }

    setSeriesModal(null);
  };
  const deleteSeriesByName = (name) => {
    const affected = fics.filter((f) => (f.seriesEntries || []).some((e) => e.seriesName === name));
    if (
      affected.length > 0 &&
      !confirm(`Delete "${name}" and move ${affected.length} fic${affected.length !== 1 ? "s" : ""} to Trash (recoverable for 30 days)?`)
    ) {
      return;
    }
    persistLists((prev) => ({ ...prev, series: prev.series.filter((s) => s.name !== name) }));
    if (affected.length > 0) persistFics((prev) => prev.filter((f) => !(f.seriesEntries || []).some((e) => e.seriesName === name)));
  };
  // Creates a lists.series entry if one doesn't exist yet for `name`, or patches in a link
  // (and optionally description/completed) onto an existing entry that's missing its link —
  // never overwrites a link that's already there. Shared by the bulk-import auto-link logic
  // and the "just save this series' info" quick action.
  const createOrPatchSeries = (name, { link, description, completed }) => {
    if (!link) return;
    persistLists((prev) => {
      const existing = prev.series.find((s) => s.name === name);
      if (!existing) {
        return { ...prev, series: [...prev.series, { id: genId(), name, description: description || "", completed: !!completed, link }] };
      }
      if (!existing.link) {
        return { ...prev, series: prev.series.map((s) => (s.id === existing.id ? { ...s, link } : s)) };
      }
      return prev; // already has a link — don't touch it
    });
  };

  const toggleSeriesCompleted = (name) => {
    persistLists((prev) => ({
      ...prev,
      series: prev.series.some((s) => s.name === name)
        ? prev.series.map((s) => (s.name === name ? { ...s, completed: !s.completed } : s))
        : [...prev.series, { id: genId(), name, description: "", completed: true }],
    }));
  };

  const runSeriesImport = async (url) => {
    setSeriesImport({ step: "fetching-series", url });
    let seriesData;
    try {
      const resp = await fetch(`/fetch-series?url=${encodeURIComponent(url)}`);
      seriesData = await resp.json();
    } catch {
      setSeriesImport({ step: "error", error: "Unexpected response from the lookup — try again." });
      return;
    }
    if (!seriesData || (seriesData.error && !seriesData.works)) {
      setSeriesImport({ step: "error", error: seriesData?.error || "Couldn't fetch that series." });
      return;
    }

    const { seriesName, description, works, completed: seriesCompleted } = seriesData;
    const added = [];
    let workingFics = ficsRef.current;
    let tagged = 0;
    const taggedFicIds = []; // ids of existing fics whose seriesEntries got updated
    const failed = [];

    for (let i = 0; i < works.length; i++) {
      setSeriesImport({ step: "fetching-works", seriesName, total: works.length, current: i + 1 });
      const workUrl = works[i];
      let meta;
      try {
        meta = await fetchMetadataFromLink(workUrl, uid);
      } catch {
        failed.push(workUrl);
        await sleep(350);
        continue;
      }
      const draftLike = { link: workUrl, title: meta.title || "", author: meta.author || "" };
      const dup = findDuplicate(draftLike, [...workingFics, ...added]);
      if (dup) {
        const existingEntries = dup.seriesEntries || [];
        const existingIdx = existingEntries.findIndex((e) => e.seriesName === seriesName);
        let nextEntries = existingEntries;
        if (existingIdx === -1) {
          nextEntries = [...existingEntries, { seriesName, seriesPosition: i + 1 }];
        } else if (existingEntries[existingIdx].seriesPosition !== i + 1) {
          nextEntries = existingEntries.map((e, idx) => (idx === existingIdx ? { ...e, seriesPosition: i + 1 } : e));
        }
        if (nextEntries !== existingEntries) {
          const updated = { ...dup, seriesEntries: nextEntries };
          workingFics = workingFics.map((f) => (f.id === dup.id ? updated : f));
          taggedFicIds.push(dup.id);
        }
        tagged++;
      } else {
        added.push({
          ...emptyFic(),
          title: meta.title || "Untitled",
          author: meta.author || "",
          fandoms: meta.fandoms || [],
          relationships: meta.relationships || [],
          characters: meta.characters || [],
          rating: meta.rating || "T",
          warnings: meta.warnings || [],
          wordCount: meta.wordCount || 0,
          chapterCurrent: meta.chapterCurrent ?? 0,
          chapterTotal: normalizeChapterTotal(meta.chapterTotal, 1),
          link: workUrl,
          source: "AO3",
          ficStatus: inferFicStatus(meta.ficStatus, meta.chapterCurrent, meta.chapterTotal),
          dateStarted: meta.dateStarted || "",
          dateFinished: meta.dateFinished || "",
          lastUpdated: meta.lastUpdated || "",
          summary: meta.summary || "",
          tags: meta.tags || [],
          seriesEntries: [{ seriesName, seriesPosition: i + 1 }],
        });
      }
      await sleep(350);
    }

    // Same reasoning as the collection/CSV importers: this loop can run for a long time
    // (one AO3 fetch per work in the series), so the final write must not be a single
    // overwrite based on the stale loop-start snapshot — that would erase anything added
    // from elsewhere (e.g. a bookmarklet import in another tab) during the run.
    if (added.length > 0) persistFicsAppend(added);
    if (taggedFicIds.length > 0) {
      const taggedSet = new Set(taggedFicIds);
      persistFics((prev) =>
        prev.map((f) => {
          if (!taggedSet.has(f.id)) return f;
          const fromWorking = workingFics.find((w) => w.id === f.id);
          return fromWorking ? { ...f, seriesEntries: fromWorking.seriesEntries } : f;
        })
      );
    }
    persistLists((prev) => {
      const existingEntry = prev.series.find((s) => s.name === seriesName);
      if (!existingEntry) {
        return {
          ...prev,
          series: [...prev.series, { id: genId(), name: seriesName, description: description || "", completed: !!seriesCompleted, link: url }],
        };
      }
      // Re-importing into a series you've already tracked — refresh its completion status
      // from AO3's own current stat, but only if we actually got a definitive answer (a
      // partial/locked fetch might not have reached the stats block at all).
      if (seriesCompleted !== null && existingEntry.completed !== seriesCompleted) {
        return {
          ...prev,
          series: prev.series.map((s) => (s.name === seriesName ? { ...s, completed: seriesCompleted } : s)),
        };
      }
      return prev;
    });

    setSeriesImport({ step: "done", seriesName, added: added.length, tagged, failed, partial: !!seriesData.partial });
  };

  const saveAuthor = (a) => {
    persistLists((prev) => ({
      ...prev,
      favoriteAuthors: prev.favoriteAuthors.some((x) => x.id === a.id)
        ? prev.favoriteAuthors.map((x) => (x.id === a.id ? a : x))
        : [...prev.favoriteAuthors, a],
    }));
    setAuthorModal(null);
  };
  const deleteAuthor = (id) => persistLists((prev) => ({ ...prev, favoriteAuthors: prev.favoriteAuthors.filter((a) => a.id !== id) }));

  /* ---- export / import / reset ---- */
  const exportData = () => {
    const blob = new Blob([JSON.stringify({ fics, lists }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fic-tracker-export-${today()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const importData = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later without this no-op-ing
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch {
        alert("That file didn't look like valid JSON.");
        return;
      }
      // Validate structure before doing anything with it — this is the check that was
      // entirely missing before: an empty, malformed, or wrong-shaped `fics` array used
      // to go straight into persistFics() with no review at all, and since persistFics
      // treats "not in the new array" as "delete this", an empty or incomplete file
      // silently wiped out everything not present in it. Now nothing gets written until
      // you've seen exactly what this file contains and explicitly chosen what to do.
      if (!Array.isArray(parsed.fics)) {
        alert("That file doesn't look like a fic-tracker export — no \"fics\" array found.");
        return;
      }
      // Every fic needs a stable, unique `id` — it's the actual Firestore document key for
      // that fic, not something derivable from AO3 itself, so files generated by an external
      // script (like one pulling from your AO3 bookmarks) typically won't have one at all.
      // If multiple fics in the file all lack an id, or have colliding/duplicate ids, the
      // app's own change-detection (which matches fics by id to decide what to write) can't
      // tell them apart — they'd collapse onto the same key, and anything that doesn't
      // survive that collapse looks indistinguishable from "this should be deleted." This is
      // a near-exact match for what actually happened before: always assigning a fresh id
      // here, regardless of what the file contains, closes that off completely. It's safe to
      // do unconditionally — matching "is this fic already in your library" is handled
      // separately below by AO3 link (and title+author as a fallback), never by id.
      const fileFics = parsed.fics
        .filter((f) => f && typeof f === "object" && typeof f.title === "string")
        .map((f) => ({ ...emptyFic(), ...f, id: genId() }));
      if (fileFics.length !== parsed.fics.length) {
        if (!confirm(`${parsed.fics.length - fileFics.length} entr${parsed.fics.length - fileFics.length === 1 ? "y" : "ies"} in this file didn't look like valid fics and will be skipped. Continue reviewing the rest?`)) {
          return;
        }
      }

      // Figure out, by AO3 link (or title+author when there's no link) — the same matching
      // findDuplicate already uses elsewhere — which file entries are genuinely new vs.
      // already in your library, so a merge only ever adds, never touches anything existing.
      const toAdd = [];
      const toRefresh = []; // { existing, fresh } pairs — duplicates that could have their AO3 stats refreshed
      fileFics.forEach((f) => {
        const existing = findDuplicate(f, ficsRef.current, null);
        if (!existing) toAdd.push(f);
        else toRefresh.push({ existing, fresh: f });
      });

      // For a full replace, this is what would be DELETED: anything currently in your
      // library that this file doesn't contain (by the same matching).
      const fileAsSet = fileFics;
      const toDeleteCount = ficsRef.current.filter((existing) => !findDuplicate(existing, fileAsSet, null)).length;

      setJsonImportReview({
        fileFics,
        fileLists: parsed.lists || null,
        toAdd,
        toRefresh,
        toDeleteCount,
        mode: "merge",
        refreshExisting: toRefresh.length > 0, // default on — this is exactly the repair scenario
        confirmReplace: false,
      });
    };
    reader.readAsText(file);
  };
  const clearAll = () => {
    persistFics([]);
    persistLists({ collections: [], favoriteAuthors: [], series: [] });
  };

  /* ---- derived data ---- */
  const seriesNames = useMemo(() => {
    const fromFics = fics.flatMap((f) => (f.seriesEntries || []).map((e) => e.seriesName)).filter(Boolean);
    const fromList = lists.series.map((s) => s.name);
    return Array.from(new Set([...fromList, ...fromFics])).sort();
  }, [fics, lists.series]);

  // Series that don't have an AO3 link saved yet — either because there's no lists.series
  // metadata entry for them at all, or there is one but its link field is empty (common
  // after a JSON import/merge, since series links were never part of that data). For each
  // one, grab one fic that's actually in that series so there's something to click through
  // to AO3 — opening that fic's page and clicking "Add to Library" there will pick up the
  // series link automatically (the bookmarklet reads it straight off the work page) and
  // fill it in here, even without re-saving the fic itself.
  const seriesNeedingLink = useMemo(() => {
    const byName = new Map(lists.series.map((s) => [s.name, s]));
    const result = [];
    seriesNames.forEach((name) => {
      const meta = byName.get(name);
      if (meta?.link) return; // already has a link, nothing to do
      const sample = fics.find((f) => f.link && (f.seriesEntries || []).some((e) => e.seriesName === name));
      if (sample) result.push({ name, sampleLink: sample.link });
    });
    return result;
  }, [fics, lists.series, seriesNames]);

  const allFandoms = useMemo(
    () => Array.from(new Set(fics.flatMap((f) => f.fandoms || []))).sort(),
    [fics]
  );

  const fandomCounts = useMemo(() => {
    const map = {};
    fics.forEach((f) => (f.fandoms || []).forEach((fd) => { map[fd] = (map[fd] || 0) + 1; }));
    return map;
  }, [fics]);

  const WORD_RANGES = {
    any: () => true,
    "0-1000": (n) => n < 1000,
    "1000-5000": (n) => n >= 1000 && n < 5000,
    "5000-10000": (n) => n >= 5000 && n < 10000,
    "10000-25000": (n) => n >= 10000 && n < 25000,
    "25000-50000": (n) => n >= 25000 && n < 50000,
    "50000-100000": (n) => n >= 50000 && n < 100000,
    "100000+": (n) => n >= 100000,
  };

  const filtered = useMemo(() => {
    let list = fics;
    if (authorFilterName) list = fics.filter((f) => f.author.toLowerCase() === authorFilterName.toLowerCase());
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter((f) => f.title.toLowerCase().includes(s) || f.author.toLowerCase().includes(s));
    }
    if (filterFandoms.length > 0) {
      list = list.filter((f) => (f.fandoms || []).some((x) => filterFandoms.includes(x)));
    }
    if (filterShip.trim()) {
      const s = filterShip.trim().toLowerCase();
      list = list.filter((f) => (f.relationships || []).some((x) => x.toLowerCase().includes(s)));
    }
    if (filterReading !== "All") list = list.filter((f) => f.readingStatus === filterReading);
    if (filterFicStatus !== "All") list = list.filter((f) => f.ficStatus === filterFicStatus);
    if (filterRating !== "All") list = list.filter((f) => f.rating === filterRating);
    if (filterWordRange !== "any") list = list.filter((f) => WORD_RANGES[filterWordRange]((f.wordCount || 0)));
    if (filterOneshotOnly) list = list.filter((f) => f.chapterTotal === 1);
    if (filterStandaloneOnly) list = list.filter((f) => !(f.seriesEntries && f.seriesEntries.length > 0));

    const sorters = {
      dateAdded_desc: (a, b) => (b.dateAdded || "").localeCompare(a.dateAdded || ""),
      dateAdded_asc: (a, b) => (a.dateAdded || "").localeCompare(b.dateAdded || ""),
      lastInteracted_desc: (a, b) =>
        (b.lastInteractedAt || b.dateAdded || "").localeCompare(a.lastInteractedAt || a.dateAdded || ""),
      title_asc: (a, b) => a.title.localeCompare(b.title),
      wordCount_desc: (a, b) => (b.wordCount || 0) - (a.wordCount || 0),
      wordCount_asc: (a, b) => (a.wordCount || 0) - (b.wordCount || 0),
      lastUpdated_asc: (a, b) => (a.lastUpdated || "9999").localeCompare(b.lastUpdated || "9999"),
    };
    return [...list].sort(sorters[sortBy] || sorters.dateAdded_desc);
  }, [fics, search, filterFandoms, filterShip, filterReading, filterFicStatus, filterRating, filterWordRange, filterOneshotOnly, filterStandaloneOnly, sortBy, authorFilterName]);

  const recs = useMemo(() => fics.filter((f) => f.addedVia === "rec"), [fics]);

  const seriesGroups = useMemo(() => {
    const map = {};
    fics.forEach((f) => {
      (f.seriesEntries || []).forEach((entry) => {
        if (!entry.seriesName) return;
        (map[entry.seriesName] = map[entry.seriesName] || []).push(f);
      });
    });
    Object.entries(map).forEach(([name, arr]) => {
      arr.sort((a, b) => {
        const pa = Number(a.seriesEntries.find((e) => e.seriesName === name)?.seriesPosition) || 0;
        const pb = Number(b.seriesEntries.find((e) => e.seriesName === name)?.seriesPosition) || 0;
        return pa - pb;
      });
    });
    return map;
  }, [fics]);

  const sortedSeriesNames = useMemo(() => {
    let arr = [...seriesNames];
    if (seriesSearch.trim()) {
      const s = seriesSearch.trim().toLowerCase();
      arr = arr.filter((name) => name.toLowerCase().includes(s));
    }
    const isDone = (name) => (lists.series.find((s) => s.name === name)?.completed ? 1 : 0);
    if (seriesSortBy === "ongoing") arr.sort((a, b) => isDone(a) - isDone(b) || a.localeCompare(b));
    else if (seriesSortBy === "complete") arr.sort((a, b) => isDone(b) - isDone(a) || a.localeCompare(b));
    return arr;
  }, [seriesNames, lists.series, seriesSortBy, seriesSearch]);

  const stats = useMemo(() => {
    const freq = (arr) => {
      const m = {};
      arr.forEach((v) => v && (m[v] = (m[v] || 0) + 1));
      return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count }));
    };
    return {
      total: fics.length,
      wordsRead: fics.reduce((s, f) => s + wordsReadOf(f), 0),
      completed: fics.filter((f) => f.readingStatus === "Completed").length,
      reading: fics.filter((f) => f.readingStatus === "Currently Reading").length,
      caughtUp: fics.filter((f) => f.readingStatus === "Caught Up").length,
      totalReads: fics.reduce((s, f) => s + (f.readCount || 0), 0),
      fandoms: freq(fics.flatMap((f) => f.fandoms || [])),
      ships: freq(fics.flatMap((f) => f.relationships || [])),
      tags: freq(fics.flatMap((f) => f.tags || [])),
    };
  }, [fics]);

  const staleWips = useMemo(
    () => fics.filter((f) => f.ficStatus === "WIP" && f.readingStatus !== "Abandoned").sort((a, b) => (a.lastUpdated || "9999").localeCompare(b.lastUpdated || "9999")),
    [fics]
  );
  // The subset of staleWips you've specifically read everything posted of — the ones
  // worth periodically checking back on, separate from WIPs you haven't started or are
  // mid-chapter on.
  const caughtUpWips = useMemo(() => staleWips.filter((f) => f.readingStatus === "Caught Up"), [staleWips]);

  // Same matching rules as findDuplicate (AO3 work id first, falling back to title+author)
  // but run once across the whole library to surface every cluster of 2+ entries that are
  // really the same fic — for spotting duplicates that slipped in before the import-side
  // fixes, not just preventing new ones.
  const duplicateGroups = useMemo(() => {
    const byKey = new Map();
    fics.forEach((f) => {
      const wid = ao3WorkId(f.link);
      const key = wid
        ? `wid:${wid}`
        : f.title && f.author
        ? `ta:${f.title.trim().toLowerCase()}|${f.author.trim().toLowerCase()}`
        : null;
      if (!key) return;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(f);
    });
    return Array.from(byKey.values()).filter((g) => g.length > 1);
  }, [fics]);

  // Grabs the work ID off the current AO3 page, builds the canonical work URL (so it always
  // matches what fetch-fic.js expects, regardless of which chapter/query params you're on),
  // and opens the tracker with ?add=<url> — which the effect above turns into a pre-filled
  // Add form.
  // Tries to read the fic's details straight out of the AO3 page you're already on (no
  // extra request to AO3 at all, so there's nothing for their anti-bot protection to flag)
  // and only falls back to the old server-fetch approach if the page doesn't look like a
  // normal, parseable work page.
  const addBookmarkletHref = `javascript:(function () { var m = location.pathname.match(/\\/works\\/(\\d+)/); if (!m) { alert('Open this on an AO3 work page first.'); return; } var workId = m[1]; var canonicalUrl = 'https://archiveofourown.org/works/' + workId; var ORIGIN='${typeof window !== "undefined" ? window.location.origin : ""}'; function openViaServerFetch() { window.open(ORIGIN + '/?add=' + encodeURIComponent(canonicalUrl), '_blank'); } try { var RATING_MAP = { 'Not Rated': 'NR', 'General Audiences': 'G', 'Teen And Up Audiences': 'T', 'Mature': 'M', 'Explicit': 'E' }; var MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }; function txt(el) { return el ? el.textContent.trim() : ''; } function tagList(scope, cls) { return Array.from(scope.querySelectorAll('dd.' + cls + ' a.tag, dd.' + cls + ' li a.tag, dd.' + cls + ' li.' + cls + ' a.tag')) .map(function (a) { return a.textContent.trim(); }); } function parseAo3Date(str) { if (!str) return null; str = str.trim(); var iso = str.match(/^(\\d{4})-(\\d{2})-(\\d{2})$/); if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3]; var mm = str.match(/(\\d+)\\s+(\\w+)\\s+(\\d{4})/); if (!mm) return null; var mon = MONTHS[mm[2]] || '01'; return mm[3] + '-' + mon + '-' + ('0' + mm[1]).slice(-2); } function ddAfterDt(label) { var dts = document.querySelectorAll('dl.work.meta.group dt, dl.stats dt'); for (var i = 0; i < dts.length; i++) { if (dts[i].textContent.trim().indexOf(label) === 0) { var dd = dts[i].nextElementSibling; if (dd && dd.tagName === 'DD') return dd; } } return null; } var titleEl = document.querySelector('h2.title.heading'); var title = titleEl ? titleEl.textContent.trim() : ''; var authorEl = document.querySelector('a[rel="author"]'); var author = authorEl ? authorEl.textContent.trim() : ''; if (!title || !author) { openViaServerFetch(); return; } var summaryEl = document.querySelector('div.summary.module blockquote.userstuff'); var summary = summaryEl ? summaryEl.textContent.trim().slice(0, 800) : ''; var ratingDd = ddAfterDt('Rating'); var ratingTag = ratingDd ? ratingDd.querySelector('a.tag') : null; var rating = ratingTag ? (RATING_MAP[ratingTag.textContent.trim()] || null) : null; var warningsDd = ddAfterDt('Archive Warning'); var warnings = warningsDd ? Array.from(warningsDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : []; var fandomDd = ddAfterDt('Fandom'); var fandoms = fandomDd ? Array.from(fandomDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : []; var relDd = ddAfterDt('Relationship'); var relationships = relDd ? Array.from(relDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : []; var charDd = ddAfterDt('Character'); var characters = charDd ? Array.from(charDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : []; var freeDd = ddAfterDt('Additional Tags'); var tags = freeDd ? Array.from(freeDd.querySelectorAll('a.tag')).map(function (a) { return a.textContent.trim(); }) : []; var wordsDd = document.querySelector('dl.stats dd.words'); var wordCount = wordsDd ? parseInt(wordsDd.textContent.replace(/[^\\d]/g, '')) || 0 : 0; var chaptersDd = document.querySelector('dl.stats dd.chapters'); var chapText = chaptersDd ? chaptersDd.textContent.trim() : ''; var chapM = chapText.match(/(\\d+)\\/(\\d+|\\?)/); var chapterCurrent = chapM ? parseInt(chapM[1]) : null; var chapterTotal = chapM ? (chapM[2] === '?' ? null : parseInt(chapM[2])) : null; var ficStatus = (chapterTotal && chapterCurrent === chapterTotal) ? 'Complete' : (chapterTotal ? 'WIP' : null); var publishedDd = ddAfterDt('Published'); var completedDd = ddAfterDt('Completed'); var updatedDd = ddAfterDt('Updated'); var published = publishedDd ? parseAo3Date(txt(publishedDd)) : null; var completed = completedDd ? parseAo3Date(txt(completedDd)) : null; var updatedRaw = updatedDd ? parseAo3Date(txt(updatedDd)) : null; var dateStarted = published, dateFinished = null, lastUpdated = null; if (chapterTotal === 1) { dateFinished = published; } else if (ficStatus === 'Complete') { dateFinished = completed || published; } else { lastUpdated = updatedRaw || published; } var seriesDd = ddAfterDt('Series'); var seriesList = []; if (seriesDd) { var posSpans = seriesDd.querySelectorAll('span.position'); for (var psi = 0; psi < posSpans.length; psi++) { var ps = posSpans[psi]; var pm2 = ps.textContent.match(/Part\\s*(\\d+)\\s*of/); var sl2 = ps.querySelector('a'); if (sl2) { var href2 = sl2.getAttribute('href') || ''; var link2 = href2.indexOf('http') === 0 ? href2 : 'https://archiveofourown.org' + href2; seriesList.push({ name: sl2.textContent.trim(), position: pm2 ? parseInt(pm2[1]) : null, link: link2 }); } } } var seriesName = seriesList.length > 0 ? seriesList[0].name : null; var seriesPosition = seriesList.length > 0 ? seriesList[0].position : null; var data = { link: canonicalUrl, title: title, author: author, fandoms: fandoms, relationships: relationships, characters: characters, rating: rating, warnings: warnings, wordCount: wordCount, chapterCurrent: chapterCurrent, chapterTotal: chapterTotal, ficStatus: ficStatus, dateStarted: dateStarted, dateFinished: dateFinished, lastUpdated: lastUpdated, summary: summary, tags: tags, seriesName: seriesName, seriesPosition: seriesPosition, seriesList: seriesList }; var json = JSON.stringify(data); var encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(json)))); window.open(ORIGIN + '/?addData=' + encoded, '_blank'); } catch (e) { openViaServerFetch(); } })();`;

  const addBulkBookmarkletHref = `javascript:(function(){var ORIGIN='${typeof window !== "undefined" ? window.location.origin : ""}';var RATING_MAP={'Not Rated':'NR','General Audiences':'G','Teen And Up Audiences':'T','Mature':'M','Explicit':'E'};var MONTHS={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};function txt(el){return el?el.textContent.trim():'';}function tagList(li,cls){return Array.from(li.querySelectorAll('ul.tags.commas li.'+cls+' a.tag')).map(function(a){return a.textContent.trim();});}function parseDate(s){var m=s.match(/(\\d+)\\s+(\\w+)\\s+(\\d{4})/);if(!m)return null;var mn=MONTHS[m[2]]||'01';return m[3]+'-'+mn+'-'+('0'+m[1]).slice(-2);}var isSeriesPage=/^\\/series\\/\\d+/.test(location.pathname);var seriesPageTitle='';var seriesPageLink='';if(isSeriesPage){var sTitleEl=document.querySelector('h2.heading');seriesPageTitle=sTitleEl?sTitleEl.textContent.trim():'';var sIdMatch=location.pathname.match(/\\/series\\/(\\d+)/);seriesPageLink=sIdMatch?'https://archiveofourown.org/series/'+sIdMatch[1]:'';}var seriesPageCompleted=null;var seriesPageDescription='';if(isSeriesPage){var allDts=document.querySelectorAll('dt');for(var di=0;di<allDts.length;di++){var dtTxt=allDts[di].textContent.trim();if(dtTxt==='Complete:'){var cdd=allDts[di].nextElementSibling;if(cdd&&cdd.tagName==='DD'){var ctxt=cdd.textContent.trim();seriesPageCompleted=ctxt==='Yes'?true:(ctxt==='No'?false:null);}}else if(dtTxt==='Description:'){var ddd=allDts[di].nextElementSibling;if(ddd&&ddd.tagName==='DD'){var bq=ddd.querySelector('blockquote');seriesPageDescription=(bq||ddd).textContent.trim();}}}}var seriesPageIdx=0;var entries=document.querySelectorAll('li.work.blurb.group,li.bookmark.blurb.group');if(!entries.length){alert('No works found. Use on a series, collection, or search results page.');return;}var works=[];entries.forEach(function(li){var workId=null;var im=li.id.match(/work_(\\d+)/);if(im)workId=im[1];else{var cm=li.className.match(/work-(\\d+)/);if(cm)workId=cm[1];}if(!workId)return;var titleEl=li.querySelector('h4.heading a:not([rel="author"])');var title=titleEl?titleEl.textContent.trim():'';if(!title)return;var authorEl=li.querySelector('h4.heading a[rel="author"]');var ratingSpan=li.querySelector('ul.required-tags span[class*="rating-"]');var ratingTxt=ratingSpan?ratingSpan.getAttribute('title'):'';var rating=RATING_MAP[ratingTxt]||null;var statusSpan=li.querySelector('ul.required-tags span[class*="complete-"]');var ficStatus=statusSpan?(statusSpan.getAttribute('title')==='Complete Work'?'Complete':'WIP'):null;var wordsEl=li.querySelector('dd.words');var wordCount=wordsEl?parseInt(wordsEl.textContent.replace(/,/g,''))||0:0;var chapEl=li.querySelector('dd.chapters');var chapM=(chapEl?chapEl.textContent.trim():'').match(/(\\d+)\\/(\\d+|\\?)/);var chapterCurrent=chapM?parseInt(chapM[1]):null;var chapterTotal=chapM?(chapM[2]==='?'?null:parseInt(chapM[2])):null;if(!ficStatus&&chapterTotal)ficStatus=chapterCurrent===chapterTotal?'Complete':'WIP';var dateEl=li.querySelector('p.datetime');var dateStr=parseDate(txt(dateEl));var summaryEl=li.querySelector('blockquote.userstuff.summary');var summary=summaryEl?summaryEl.textContent.trim().slice(0,250):'';var seriesName=null,seriesPosition=null,seriesLink=null;if(isSeriesPage){seriesName=seriesPageTitle||null;seriesPageIdx++;seriesPosition=seriesPageIdx;seriesLink=seriesPageLink||null;}else{var seriesLi=li.querySelector('ul.series li');if(seriesLi){var pm=seriesLi.textContent.match(/Part\\\\s+(\\\\d+)\\\\s+of/);var sl=seriesLi.querySelector('a');seriesPosition=pm?parseInt(pm[1]):null;seriesName=sl?sl.textContent.trim():null;if(sl){var href3=sl.getAttribute('href')||'';seriesLink=href3.indexOf('http')===0?href3:'https://archiveofourown.org'+href3;}}}works.push({link:'https://archiveofourown.org/works/'+workId,title:title,author:txt(authorEl),fandoms:Array.from(li.querySelectorAll('h5.fandoms.heading a.tag')).map(function(a){return a.textContent.trim();}),relationships:tagList(li,'relationships'),characters:tagList(li,'characters'),rating:rating,warnings:tagList(li,'warnings'),wordCount:wordCount,chapterCurrent:chapterCurrent,chapterTotal:chapterTotal,ficStatus:ficStatus,dateStarted:dateStr,dateFinished:ficStatus==='Complete'?dateStr:null,lastUpdated:ficStatus!=='Complete'?dateStr:null,summary:summary,tags:tagList(li,'freeforms'),seriesName:seriesName,seriesPosition:seriesPosition,seriesLink:seriesLink});});if(!works.length){alert('Could not extract works from this page.');return;}var pageTitleEl=document.querySelector('h2.heading');var payload={works:works,sourceTitle:pageTitleEl?pageTitleEl.textContent.trim():'',sourcePage:location.href,sourceCompleted:seriesPageCompleted,sourceDescription:seriesPageDescription};var json=JSON.stringify(payload);var encoded=encodeURIComponent(btoa(unescape(encodeURIComponent(json))));if(encoded.length>60000){works.forEach(function(w){w.summary='';});json=JSON.stringify({works:works,sourceTitle:payload.sourceTitle,sourcePage:payload.sourcePage});encoded=encodeURIComponent(btoa(unescape(encodeURIComponent(json))));}window.open(ORIGIN+'/?addBulk='+encoded,'_blank');})()`;
  const updateProgressBookmarkletHref = `javascript:(function () { var ORIGIN = '${typeof window !== "undefined" ? window.location.origin : ""}'; var m = location.pathname.match(/\\/works\\/(\\d+)/); if (!m) { alert('Open this on an AO3 fic chapter page first.'); return; } var workId = m[1]; var canonicalUrl = 'https://archiveofourown.org/works/' + workId; var currentUrl = location.href.split('#')[0]; var chapterNum = null; var sel = document.querySelector('select#selected_id'); if (sel && sel.selectedIndex >= 0) { var opt = sel.options[sel.selectedIndex]; if (opt) { var om = opt.textContent.match(/^\\s*(\\d+)\\s*\\./); if (om) chapterNum = parseInt(om[1]); } } if (!chapterNum) { var h3s = document.querySelectorAll('h3.title'); for (var i = 0; i < h3s.length; i++) { var hm = h3s[i].textContent.match(/Chapter\\s+(\\d+)/i); if (hm) { chapterNum = parseInt(hm[1]); break; } } } if (!chapterNum && document.title) { var tm = document.title.match(/Chapter\\s+(\\d+)/i); if (tm) chapterNum = parseInt(tm[1]); } if (!chapterNum && !/\\/chapters\\//.test(location.pathname)) { chapterNum = 1; } var data = { link: canonicalUrl, chapterUrl: currentUrl }; if (chapterNum) data.chapterNumber = chapterNum; var json = JSON.stringify(data); var encoded = encodeURIComponent(btoa(unescape(encodeURIComponent(json)))); window.open(ORIGIN + '/?updateProgress=' + encoded, '_blank'); })();`;


  /* ---------------------------------------------------------------- */

  if (!loaded) {
    return (
      <div className="ft-root ft-loading">
        <style>{CSS}</style>
        {loadError ? (
          <>
            <AlertTriangle size={22} color="var(--c-rose)" />
            <span style={{ color: "var(--c-rose)", maxWidth: 480, textAlign: "center" }}>
              Couldn't load your library — {loadError}
            </span>
            <p className="ft-muted" style={{ maxWidth: 480, textAlign: "center", marginTop: 8 }}>
              This usually means a Firestore permissions issue on the new per-fic storage path.
              Check that your Firestore security rules cover <code>users/&#123;uid&#125;/fics/&#123;ficId&#125;</code>,
              not just <code>users/&#123;uid&#125;</code> — rules don't automatically apply to subcollections.
            </p>
          </>
        ) : (
          <>
            <Loader2 size={22} className="ft-spin" />
            <span>Opening your library…</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="ft-root">
      <style>{CSS}</style>

      {toast && (
        <div className={"ft-toast" + (toast.kind === "warn" ? " ft-toast-warn" : "")}>
          <span>{toast.text}</span>
          {toast.undoIds && toast.undoIds.length > 0 && (
            <button
              className="ft-pill"
              style={{ marginLeft: 4 }}
              onClick={() => { toast.undoIds.forEach((id) => undoEntry(id)); setToast(null); }}
            >
              <Undo2 size={12} /> Undo
            </button>
          )}
          <button className="ft-iconbtn" onClick={() => setToast(null)}><X size={14} /></button>
        </div>
      )}

      <nav className="ft-nav">
        <div className="ft-brand"><BookOpen size={18} /> <span>Fic Tracker</span></div>
        <div className="ft-nav-items">
          {NAV_ITEMS.map((n) => (
            <button
              key={n.id}
              className={"ft-nav-item" + (tab === n.id ? " ft-nav-item-active" : "")}
              onClick={() => { setTab(n.id); setAuthorFilterName(null); }}
            >
              <n.icon size={15} /> <span>{n.label}</span>
            </button>
          ))}
        </div>
        <div className="ft-nav-actions">
          {trash.length > 0 && (
            <button className="ft-iconbtn ft-nav-settings" style={{ position: "relative" }} onClick={() => setTrashOpen(true)} title={`Trash (${trash.length})`}>
              <Trash2 size={16} />
              <span className="ft-trash-badge">{trash.length}</span>
            </button>
          )}
          {duplicateGroups.length > 0 && (
            <button
              className="ft-iconbtn ft-nav-settings"
              style={{ position: "relative" }}
              onClick={() => setDuplicatesOpen(true)}
              title={`Possible duplicates (${duplicateGroups.length})`}
            >
              <Copy size={16} />
              <span className="ft-trash-badge">{duplicateGroups.length}</span>
            </button>
          )}
          {undoStack.length > 0 && (
            <button
              className="ft-iconbtn ft-nav-settings"
              style={{ position: "relative" }}
              onClick={() => setUndoOpen(true)}
              title={`Recent changes (${undoStack.length})`}
            >
              <Undo2 size={16} />
              <span className="ft-trash-badge">{undoStack.length}</span>
            </button>
          )}
          <button className="ft-iconbtn ft-nav-settings" onClick={() => setSettingsOpen(true)} title="Settings">
            <Settings size={16} />
          </button>
        </div>
      </nav>

      <main className="ft-main">
        {(tab === "library" || tab === "recs") && (
          <>
            <div className="ft-topbar">
              <div className="ft-search">
                <Search size={15} />
                <input placeholder="Search title or author…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {tab === "library" && (
                <span className="ft-muted" style={{ whiteSpace: "nowrap" }}>
                  {fics.length} fic{fics.length !== 1 ? "s" : ""} total
                  {filtered.length !== fics.length && ` · ${filtered.length} shown`}
                </span>
              )}
              <button className="ft-btn ft-btn-ghost" onClick={() => { setGridSelectMode((m) => !m); setGridSelected(new Set()); }}>
                {gridSelectMode ? "Cancel" : "Select"}
              </button>
              <button className="ft-btn ft-btn-primary" onClick={openAdd}><Plus size={15} /> Add fic</button>
            </div>

            {gridSelectMode && (() => {
              const items = tab === "library" ? filtered : recs;
              const allSelected = items.length > 0 && gridSelected.size === items.length;
              return (
                <div className="ft-bulkbar">
                  <button className="ft-pill" onClick={() => setGridSelected(allSelected ? new Set() : new Set(items.map((f) => f.id)))}>
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                  {gridSelected.size > 0 && (
                    <>
                      <span className="ft-muted">{gridSelected.size} selected</span>
                      <button
                        className="ft-pill"
                        onClick={() => setCollectionPicker({ title: `Add ${gridSelected.size} fic${gridSelected.size !== 1 ? "s" : ""} to a collection`, ficIds: Array.from(gridSelected), selected: [], newName: "" })}
                      >
                        <Bookmark size={13} /> Add to collection
                      </button>
                      <button
                        className="ft-pill"
                        onClick={() => { bulkMarkStatus(Array.from(gridSelected), "Completed"); setGridSelected(new Set()); setGridSelectMode(false); }}
                      >
                        <Check size={13} /> Mark read
                      </button>
                      <button
                        className="ft-pill"
                        onClick={() => { bulkMarkStatus(Array.from(gridSelected), "Unread"); setGridSelected(new Set()); setGridSelectMode(false); }}
                      >
                        Mark unread
                      </button>
                      <button
                        className="ft-pill ft-pill-danger"
                        onClick={() => {
                          if (!confirm(`Move ${gridSelected.size} fic${gridSelected.size !== 1 ? "s" : ""} to Trash (recoverable for 30 days)?`)) return;
                          const idsToDelete = new Set(gridSelected);
                          persistFics((prev) => prev.filter((f) => !idsToDelete.has(f.id)));
                          setGridSelected(new Set());
                          setGridSelectMode(false);
                        }}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </>
                  )}
                </div>
              );
            })()}

            {tab === "library" && (
              <div className="ft-filterbar">
                <MultiSelectFilter label="Fandoms" options={allFandoms} selected={filterFandoms} onChange={setFilterFandoms} placeholder="Filter by fandom…" counts={fandomCounts} />
                <input className="ft-filter-input" placeholder="Filter by ship…" value={filterShip} onChange={(e) => setFilterShip(e.target.value)} />
                <select value={filterReading} onChange={(e) => setFilterReading(e.target.value)}>
                  <option>All</option>
                  {READING_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
                <select value={filterFicStatus} onChange={(e) => setFilterFicStatus(e.target.value)}>
                  <option>All</option>
                  {FIC_STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
                <select value={filterRating} onChange={(e) => setFilterRating(e.target.value)}>
                  <option>All</option>
                  {RATINGS.map((s) => <option key={s}>{s}</option>)}
                </select>
                <select value={filterWordRange} onChange={(e) => setFilterWordRange(e.target.value)}>
                  <option value="any">Any length</option>
                  <option value="0-1000">Under 1k</option>
                  <option value="1000-5000">1k – 5k</option>
                  <option value="5000-10000">5k – 10k</option>
                  <option value="10000-25000">10k – 25k</option>
                  <option value="25000-50000">25k – 50k</option>
                  <option value="50000-100000">50k – 100k</option>
                  <option value="100000+">100k+</option>
                </select>
                <label className="ft-check" style={{ background: "var(--c-surface)", border: "1px solid var(--c-border)", borderRadius: 6, padding: "7px 10px" }}>
                  <input type="checkbox" checked={filterOneshotOnly} onChange={(e) => setFilterOneshotOnly(e.target.checked)} />
                  Oneshots only
                </label>
                <label className="ft-check" style={{ background: "var(--c-surface)", border: "1px solid var(--c-border)", borderRadius: 6, padding: "7px 10px" }}>
                  <input type="checkbox" checked={filterStandaloneOnly} onChange={(e) => setFilterStandaloneOnly(e.target.checked)} />
                  Standalone only
                </label>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                  <option value="dateAdded_desc">Newest added</option>
                  <option value="dateAdded_asc">Oldest added</option>
                  <option value="lastInteracted_desc">Recently interacted</option>
                  <option value="title_asc">Title A–Z</option>
                  <option value="wordCount_desc">Longest first</option>
                  <option value="wordCount_asc">Shortest first</option>
                  <option value="lastUpdated_asc">Stalest WIP first</option>
                </select>
                {authorFilterName && (
                  <button className="ft-pill" onClick={() => setAuthorFilterName(null)}>
                    Author: {authorFilterName} <X size={11} />
                  </button>
                )}
                {hasActiveFilters && (
                  <button className="ft-pill" onClick={clearAllFilters}>
                    <X size={11} /> Clear filters
                  </button>
                )}
              </div>
            )}

            <div className="ft-grid">
              {(tab === "library" ? filtered : recs).length === 0 ? (
                <EmptyState
                  icon={tab === "library" ? BookOpen : Inbox}
                  title={tab === "library" ? "Nothing here yet" : "No recs queued"}
                  body={tab === "library" ? "Add your first fic, or paste a link to pull in the details automatically." : "When a friend recs you something, add it and check “this is a rec from a friend” to keep it separate from your own to-read pile."}
                />
              ) : (
                (tab === "library" ? filtered : recs).map((f) => (
                  <div key={f.id} style={{ position: "relative" }}>
                    {gridSelectMode && (
                      <label className="ft-select-overlay">
                        <input
                          type="checkbox"
                          checked={gridSelected.has(f.id)}
                          onChange={() =>
                            setGridSelected((prev) => {
                              const next = new Set(prev);
                              next.has(f.id) ? next.delete(f.id) : next.add(f.id);
                              return next;
                            })
                          }
                        />
                      </label>
                    )}
                    <FicCard
                      fic={f}
                      onEdit={openEdit}
                      onDelete={deleteFic}
                      onQuickStatus={quickStatus}
                      confirmingDelete={confirmDeleteId === f.id}
                    />
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {tab === "series" && (
          <div className="ft-section">
            <div className="ft-section-head">
              <h1>Series</h1>
              <div className="ft-card-actions" style={{ gap: 8 }}>
                <input
                  className="ft-filter-input"
                  placeholder="Search series…"
                  value={seriesSearch}
                  onChange={(e) => setSeriesSearch(e.target.value)}
                />
                <select value={seriesSortBy} onChange={(e) => setSeriesSortBy(e.target.value)}>
                  <option value="name">Sort: Name A–Z</option>
                  <option value="ongoing">Sort: Ongoing first</option>
                  <option value="complete">Sort: Complete first</option>
                </select>
                <button className="ft-btn ft-btn-ghost" onClick={() => { setSeriesImportUrl(""); setSeriesImport({ step: "input" }); }}>
                  <Link2 size={15} /> Add from AO3 series link
                </button>
                {seriesNeedingLink.length > 0 && (
                  <button className="ft-btn ft-btn-ghost" onClick={() => setShowMissingLinks(true)}>
                    <AlertTriangle size={15} /> Fix {seriesNeedingLink.length} missing link{seriesNeedingLink.length !== 1 ? "s" : ""}
                  </button>
                )}
                <button className="ft-btn ft-btn-primary" onClick={() => setSeriesModal({ id: genId(), name: "", description: "", completed: false })}>
                  <Plus size={15} /> New series
                </button>
              </div>
            </div>

            {sortedSeriesNames.length === 0 ? (
              <EmptyState
                icon={Layers}
                title={seriesSearch.trim() ? "No matching series" : "No series yet"}
                body={seriesSearch.trim() ? "Try a different search." : "Create one ahead of time, or just give matching fics the same series name and they'll group together here."}
              />
            ) : (
              <>
                {sortedSeriesNames.map((name) => {
                  const meta = lists.series.find((s) => s.name === name);
                  const items = seriesGroups[name] || [];
                  const collapsed = collapsedSeries.has(name);
                  return (
                    <SeriesBlock
                      key={name}
                      name={name}
                      meta={meta}
                      items={items}
                      collapsed={collapsed}
                      onToggleCollapse={() => toggleCollapsed(setCollapsedSeries, name)}
                      onAddToCollection={(ficIds) => setCollectionPicker({ title: `Add ${ficIds.length} fic${ficIds.length !== 1 ? "s" : ""} to a collection`, ficIds, selected: [], newName: "" })}
                      onToggleCompleted={() => toggleSeriesCompleted(name)}
                      onEdit={() => setSeriesModal({ ...(meta || { id: genId(), name, description: "", completed: false }), originalName: name })}
                      onDelete={() => deleteSeriesByName(name)}
                      onBulkDelete={(ficIds) => {
                        if (!confirm(`Move ${ficIds.length} fic${ficIds.length !== 1 ? "s" : ""} to Trash (recoverable for 30 days)?`)) return;
                        const idSet = new Set(ficIds);
                        persistFics((prev) => prev.filter((f) => !idSet.has(f.id)));
                      }}
                      onBulkMarkStatus={bulkMarkStatus}
                      onEditFic={openEdit}
                      onDeleteFic={deleteFic}
                      onQuickStatus={quickStatus}
                      confirmDeleteId={confirmDeleteId}
                    />
                  );
                })}
              </>
            )}
          </div>
        )}

        {tab === "collections" && (
          <div className="ft-section">
            <div className="ft-section-head">
              <h1>Collections</h1>
              <div className="ft-card-actions" style={{ gap: 8 }}>
                <input
                  className="ft-filter-input"
                  placeholder="Search collections…"
                  value={collectionSearch}
                  onChange={(e) => setCollectionSearch(e.target.value)}
                />
                <button className="ft-btn ft-btn-primary" onClick={() => setCollectionModal({ id: genId(), name: "", description: "" })}>
                  <Plus size={15} /> New collection
                </button>
              </div>
            </div>
            {(() => {
              const visibleCollections = collectionSearch.trim()
                ? lists.collections.filter((c) => c.name.toLowerCase().includes(collectionSearch.trim().toLowerCase()))
                : lists.collections;
              if (visibleCollections.length === 0) {
                return (
                  <EmptyState
                    icon={Bookmark}
                    title={collectionSearch.trim() ? "No matching collections" : "No collections yet"}
                    body={collectionSearch.trim() ? "Try a different search." : "Group fics by theme — slow burns, found family, canon divergence, whatever you like."}
                  />
                );
              }
              return visibleCollections.map((c) => {
                const items = fics.filter((f) => (f.collections || []).includes(c.id));
                const collapsed = collapsedCollections.has(c.id);
                return (
                  <CollectionBlock
                    key={c.id}
                    collection={c}
                    items={items}
                    collapsed={collapsed}
                    onToggleCollapse={() => toggleCollapsed(setCollapsedCollections, c.id)}
                    onEdit={() => setCollectionModal(c)}
                    onDelete={() => deleteCollection(c.id)}
                    onRemoveSelected={(ficIds) => removeFromCollection(c.id, ficIds)}
                    onMoveSelected={(toId, ficIds) => moveToCollection(c.id, toId, ficIds)}
                    onBulkDelete={(ficIds) => {
                      if (!confirm(`Move ${ficIds.length} fic${ficIds.length !== 1 ? "s" : ""} to Trash (recoverable for 30 days)?`)) return;
                      const idSet = new Set(ficIds);
                      persistFics((prev) => prev.filter((f) => !idSet.has(f.id)));
                    }}
                    onBulkMarkStatus={bulkMarkStatus}
                    allCollections={lists.collections}
                    onEditFic={openEdit}
                    onDeleteFic={deleteFic}
                    onQuickStatus={quickStatus}
                    confirmDeleteId={confirmDeleteId}
                  />
                );
              });
            })()}
          </div>
        )}

        {tab === "authors" && (
          <div className="ft-section">
            <div className="ft-section-head">
              <h1>Favorite authors</h1>
              <button className="ft-btn ft-btn-primary" onClick={() => setAuthorModal({ id: genId(), name: "", platform: "AO3", link: "", notes: "" })}>
                <Plus size={15} /> Add author
              </button>
            </div>
            {lists.favoriteAuthors.length === 0 ? (
              <EmptyState icon={Heart} title="No favorite authors yet" body="Keep track of writers whose new work you want to catch." />
            ) : (
              <div className="ft-author-grid">
                {lists.favoriteAuthors.map((a) => {
                  const count = fics.filter((f) => f.author.toLowerCase() === a.name.toLowerCase()).length;
                  return (
                    <div key={a.id} className="ft-card">
                      <div className="ft-card-top">
                        <div>
                          <a href={a.link || undefined} target="_blank" rel="noreferrer" className="ft-card-title">{a.name}</a>
                          <div className="ft-card-author">{a.platform} · {count} fic{count !== 1 ? "s" : ""} in your library</div>
                        </div>
                        <div className="ft-card-actions">
                          <button className="ft-iconbtn" onClick={() => setAuthorModal(a)}><Pencil size={14} /></button>
                          <button className="ft-iconbtn" onClick={() => deleteAuthor(a.id)}><Trash2 size={14} /></button>
                        </div>
                      </div>
                      {a.notes && <p className="ft-muted">{a.notes}</p>}
                      <button className="ft-pill" onClick={() => { setAuthorFilterName(a.name); setTab("library"); }}>View their fics</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {tab === "stats" && (
          <div className="ft-section">
            <h1>Stats</h1>
            <div className="ft-stat-grid">
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(stats.total)}</span><span>Total fics</span></div>
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(stats.wordsRead)}</span><span>Words read</span></div>
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(stats.completed)}</span><span>Completed</span></div>
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(stats.reading)}</span><span>Currently reading</span></div>
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(stats.caughtUp)}</span><span>Caught up (WIPs)</span></div>
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(stats.totalReads)}</span><span>Total reads</span></div>
              <div className="ft-stat-card"><span className="ft-stat-num">{fmtNum(staleWips.length)}</span><span>Open WIPs</span></div>
            </div>

            <div className="ft-chart-grid">
              <ChartBlock title="Top fandoms" data={stats.fandoms} color="var(--c-accent)" />
              <ChartBlock title="Top ships" data={stats.ships} color="var(--c-rose)" />
              <ChartBlock title="Top tags / tropes" data={stats.tags} color="var(--c-blue)" />
            </div>

            {caughtUpWips.length > 0 && (
              <div className="ft-series-block">
                <h3>Caught up, waiting on updates</h3>
                <p className="ft-muted">WIPs you've read everything posted of so far — sorted by least recently updated.</p>
                <div className="ft-grid">
                  {caughtUpWips.slice(0, 6).map((f) => <FicCard key={f.id} fic={f} onEdit={openEdit} onDelete={deleteFic} onQuickStatus={quickStatus} confirmingDelete={confirmDeleteId === f.id} />)}
                </div>
              </div>
            )}

            {staleWips.length > 0 && (
              <div className="ft-series-block">
                <h3>WIPs to check on</h3>
                <p className="ft-muted">Sorted by least recently updated.</p>
                <div className="ft-grid">
                  {staleWips.slice(0, 6).map((f) => <FicCard key={f.id} fic={f} onEdit={openEdit} onDelete={deleteFic} onQuickStatus={quickStatus} confirmingDelete={confirmDeleteId === f.id} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {trashOpen && (() => {
        const allSelected = trash.length > 0 && trashSelected.size === trash.length;
        const toggleAll = () => setTrashSelected(allSelected ? new Set() : new Set(trash.map((f) => f.id)));
        const toggleOne = (id) =>
          setTrashSelected((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
          });
        const daysLeft = (deletedAt) => {
          const elapsed = (Date.now() - (deletedAt || 0)) / (24 * 60 * 60 * 1000);
          return Math.max(0, Math.ceil(30 - elapsed));
        };
        return (
          <Modal title={`Trash (${trash.length})`} onClose={() => { setTrashOpen(false); setTrashSelected(new Set()); }}>
            <p className="ft-muted">
              Deleted fics sit here for 30 days before they're gone for good — plenty of time to change your mind.
            </p>
            {trash.length === 0 ? (
              <p className="ft-muted" style={{ marginTop: 12 }}>Nothing in the trash.</p>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0" }}>
                  <button className="ft-pill" onClick={toggleAll}>{allSelected ? "Deselect all" : "Select all"}</button>
                  {trashSelected.size > 0 && (
                    <>
                      <button className="ft-pill" onClick={() => { restoreTrashFics(Array.from(trashSelected)); setTrashSelected(new Set()); }}>
                        <Undo2 size={13} /> Restore {trashSelected.size}
                      </button>
                      <button className="ft-pill ft-pill-danger" onClick={() => { permanentDeleteTrashFics(Array.from(trashSelected)); setTrashSelected(new Set()); }}>
                        <Trash2 size={13} /> Delete forever
                      </button>
                    </>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
                  {trash
                    .slice()
                    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
                    .map((f) => (
                      <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", border: "1px solid var(--c-border)", borderRadius: 6 }}>
                        <input type="checkbox" checked={trashSelected.has(f.id)} onChange={() => toggleOne(f.id)} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title || "Untitled"}</div>
                          <div className="ft-muted" style={{ fontSize: 11 }}>
                            {f.author ? `by ${f.author} · ` : ""}auto-deletes in {daysLeft(f.deletedAt)} day{daysLeft(f.deletedAt) !== 1 ? "s" : ""}
                          </div>
                        </div>
                        <button className="ft-iconbtn" title="Restore" onClick={() => restoreTrashFics([f.id])}>
                          <Undo2 size={14} />
                        </button>
                        <button className="ft-iconbtn" title="Delete forever" onClick={() => permanentDeleteTrashFics([f.id])}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                </div>
              </>
            )}
            <div className="ft-modal-footer">
              <button className="ft-btn ft-btn-ghost" onClick={() => { setTrashOpen(false); setTrashSelected(new Set()); }}>Close</button>
            </div>
          </Modal>
        );
      })()}

      {undoOpen && (
        <Modal title={`Recent changes (${undoStack.length})`} onClose={() => setUndoOpen(false)}>
          <p className="ft-muted">
            The last {MAX_UNDO} library-changing actions this session — newest first. Undoing one only reverts that
            action; it doesn't touch anything you've done since.
          </p>
          {undoStack.length === 0 ? (
            <p className="ft-muted" style={{ marginTop: 12 }}>Nothing to undo right now.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto", marginTop: 10 }}>
              {undoStack.map((entry) => (
                <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 8px", border: "1px solid var(--c-border)", borderRadius: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</div>
                    <div className="ft-muted" style={{ fontSize: 11 }}>{fmtDate(new Date(entry.ts).toISOString().slice(0, 10))} · {new Date(entry.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
                  </div>
                  <button className="ft-pill" onClick={() => undoEntry(entry.id)}>
                    <Undo2 size={13} /> Undo
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ft-modal-footer">
            <button className="ft-btn ft-btn-ghost" onClick={() => setUndoOpen(false)}>Close</button>
          </div>
        </Modal>
      )}

      {duplicatesOpen && (
        <Modal title={`Possible duplicates (${duplicateGroups.length})`} onClose={() => setDuplicatesOpen(false)} wide>
          <p className="ft-muted">
            Entries that share the same AO3 link, or the same title and author. Pick which one to keep — its series
            links, collections, and tags get the others' merged in (reading progress and notes stay whatever the kept
            one already has), and the rest go to Trash.
          </p>
          {duplicateGroups.length === 0 ? (
            <p className="ft-muted" style={{ marginTop: 12 }}>None found.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: 420, overflowY: "auto", marginTop: 10 }}>
              {duplicateGroups.map((group, gi) => (
                <div key={gi} style={{ border: "1px solid var(--c-border)", borderRadius: 8, padding: 10 }}>
                  {group.map((f) => (
                    <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 4px" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title || "Untitled"}</div>
                        <div className="ft-muted" style={{ fontSize: 11 }}>
                          by {f.author} · {fmtNum(f.wordCount)} words · {f.chapterCurrent || 0}/{f.chapterTotal} ch · {f.readingStatus} · added {fmtDate(f.dateAdded)}
                          {(f.seriesEntries || []).length > 0 && ` · in ${f.seriesEntries.map((e) => e.seriesName).join(", ")}`}
                        </div>
                      </div>
                      <button
                        className="ft-pill"
                        onClick={() => mergeDuplicatesInto(f.id, group.filter((o) => o.id !== f.id).map((o) => o.id))}
                      >
                        Keep this one
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <div className="ft-modal-footer">
            <button className="ft-btn ft-btn-ghost" onClick={() => setDuplicatesOpen(false)}>Close</button>
          </div>
        </Modal>
      )}

      {showMissingLinks && (
        <Modal title={`Fix ${seriesNeedingLink.length} missing series link${seriesNeedingLink.length !== 1 ? "s" : ""}`} onClose={() => setShowMissingLinks(false)}>
          <p className="ft-muted">
            These series don't have their AO3 link saved yet (common after a JSON import/merge, since that
            data doesn't carry series links). Click "Open on AO3" for one, then click your "Add to Library"
            bookmarklet on that work page — it reads the series link straight off the page and fills it in here
            automatically, even though the fic itself is already in your library (you can close the form that
            pops up without saving — the link gets fixed either way). If that doesn't work for a particular one,
            an alternative: open the series itself on AO3 (the link is in the work page's "Series:" section) and
            use "Add Page to Library" there instead, or just paste the series URL in manually via Edit. This
            list updates itself as each one gets fixed.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10, maxHeight: 320, overflowY: "auto" }}>
            {seriesNeedingLink.map(({ name, sampleLink }) => (
              <div key={name} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "6px 8px", border: "1px solid var(--c-border)", borderRadius: 6 }}>
                <span style={{ fontSize: 13 }}>{name}</span>
                <a href={sampleLink} target="_blank" rel="noreferrer" className="ft-pill" style={{ flexShrink: 0 }}>
                  Open on AO3 →
                </a>
              </div>
            ))}
          </div>
          <div className="ft-modal-footer">
            <button className="ft-btn ft-btn-primary" onClick={() => setShowMissingLinks(false)}>Done</button>
          </div>
        </Modal>
      )}

      {jsonImportReview && (() => {
        const r = jsonImportReview;
        const isReplace = r.mode === "replace";
        return (
          <div className="ft-modal-backdrop" onClick={(e) => e.target === e.currentTarget && setJsonImportReview(null)}>
            <div className="ft-modal" style={{ maxWidth: 460 }}>
              <div className="ft-modal-head">
                <h2>Review import</h2>
                <button className="ft-iconbtn" onClick={() => setJsonImportReview(null)}><X size={16} /></button>
              </div>

              <p className="ft-muted">
                This file has {r.fileFics.length} fic{r.fileFics.length !== 1 ? "s" : ""}. Your library currently has {fics.length}.
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "12px 0" }}>
                <label className="ft-radio-card">
                  <input type="radio" checked={!isReplace} onChange={() => setJsonImportReview((p) => ({ ...p, mode: "merge", confirmReplace: false }))} />
                  <div>
                    <strong>Merge (safe, recommended)</strong>
                    <p className="ft-muted" style={{ margin: "2px 0 0" }}>
                      Adds {r.toAdd.length} new fic{r.toAdd.length !== 1 ? "s" : ""} from this file. Nothing already in your library is removed, even if it's missing from this file.
                    </p>
                    {r.toRefresh.length > 0 && (
                      <label className="ft-check" style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={r.refreshExisting}
                          onChange={(e) => setJsonImportReview((p) => ({ ...p, refreshExisting: e.target.checked }))}
                        />
                        Also refresh AO3 stats (word count, chapters posted/total, status) on {r.toRefresh.length} fic{r.toRefresh.length !== 1 ? "s" : ""} already in your library that this file matches — your reading progress, notes, and collections are never touched.
                      </label>
                    )}
                  </div>
                </label>

                <label className="ft-radio-card" style={isReplace ? { borderColor: "var(--c-rose)" } : undefined}>
                  <input type="radio" checked={isReplace} onChange={() => setJsonImportReview((p) => ({ ...p, mode: "replace" }))} />
                  <div>
                    <strong style={{ color: "var(--c-rose)" }}>Replace everything</strong>
                    <p className="ft-muted" style={{ margin: "2px 0 0" }}>
                      Makes your library exactly match this file.
                      {r.toDeleteCount > 0 ? (
                        <> This will move <strong style={{ color: "var(--c-rose)" }}>{r.toDeleteCount} fic{r.toDeleteCount !== 1 ? "s" : ""}</strong> currently in your library (that aren't in this file) to Trash — recoverable for 30 days, then gone for good.</>
                      ) : (
                        " Every fic currently in your library is also in this file, so nothing would actually be removed."
                      )}
                    </p>
                  </div>
                </label>
              </div>

              {isReplace && r.toDeleteCount > 0 && (
                <label className="ft-check" style={{ color: "var(--c-rose)" }}>
                  <input
                    type="checkbox"
                    checked={r.confirmReplace}
                    onChange={(e) => setJsonImportReview((p) => ({ ...p, confirmReplace: e.target.checked }))}
                  />
                  I understand this will move {r.toDeleteCount} fic{r.toDeleteCount !== 1 ? "s" : ""} to Trash.
                </label>
              )}

              <div className="ft-modal-footer">
                <button className="ft-btn ft-btn-ghost" onClick={() => setJsonImportReview(null)}>Cancel</button>
                <button
                  className={isReplace ? "ft-btn ft-btn-danger" : "ft-btn ft-btn-primary"}
                  disabled={isReplace ? (r.toDeleteCount > 0 && !r.confirmReplace) : (r.toAdd.length === 0 && !(r.refreshExisting && r.toRefresh.length > 0))}
                  onClick={() => {
                    if (isReplace) {
                      persistFics(r.fileFics);
                    } else {
                      if (r.toAdd.length > 0) persistFicsAppend(r.toAdd);
                      if (r.refreshExisting && r.toRefresh.length > 0) {
                        const refreshMap = new Map(r.toRefresh.map((pair) => [pair.existing.id, pair.fresh]));
                        persistFics((prev) =>
                          prev.map((f) => (refreshMap.has(f.id) ? refreshFicWithFreshData(f, refreshMap.get(f.id)) : f))
                        );
                      }
                    }
                    if (r.fileLists) persistLists(r.fileLists);
                    setJsonImportReview(null);
                    if (isReplace) {
                      setToast({ kind: "ok", text: `Library replaced — now matches the imported file.` });
                    } else {
                      const parts = [];
                      if (r.toAdd.length > 0) parts.push(`added ${r.toAdd.length} fic${r.toAdd.length !== 1 ? "s" : ""}`);
                      if (r.refreshExisting && r.toRefresh.length > 0) parts.push(`refreshed ${r.toRefresh.length} fic${r.toRefresh.length !== 1 ? "s" : ""}`);
                      const summary = parts.length > 0 ? parts.join(" and ") : "nothing to do";
                      setToast({ kind: "ok", text: summary.charAt(0).toUpperCase() + summary.slice(1) + "." });
                    }
                  }}
                >
                  {isReplace
                    ? `Replace library`
                    : [
                        r.toAdd.length > 0 ? `Add ${r.toAdd.length}` : null,
                        r.refreshExisting && r.toRefresh.length > 0 ? `Refresh ${r.toRefresh.length}` : null,
                      ].filter(Boolean).join(", ") || "Nothing to do"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {bulkImport && (
        <BulkImportPanel
          payload={bulkImport}
          existingFics={fics}
          onClose={() => setBulkImport(null)}
          onSaveSeriesInfoOnly={(payload) => {
            if (payload.sourceTitle) {
              createOrPatchSeries(payload.sourceTitle, {
                link: payload.sourcePage,
                description: payload.sourceDescription,
                completed: payload.sourceCompleted,
              });
            }
            setBulkImport(null);
            setToast({ kind: "ok", text: `Saved "${payload.sourceTitle}"'s link${payload.sourceDescription ? " and description" : ""} — no fics were added.` });
          }}
          onAdd={(drafts, seriesLinks, skippedDupCount, refreshes) => {
            const undoIds = [];
            if (drafts.length > 0) {
              const newFics = drafts.map((d) => ({ ...emptyFic(), ...d, id: genId(), dateAdded: today() }));
              persistFicsAppend(newFics);
              if (undoStackRef.current[0]) undoIds.push(undoStackRef.current[0].id);
            }
            if (refreshes && refreshes.length > 0) {
              const refreshMap = new Map(refreshes.map((r) => [r.existing.id, r.fresh]));
              persistFics((prev) =>
                prev.map((f) => (refreshMap.has(f.id) ? refreshFicWithFreshData(f, refreshMap.get(f.id)) : f))
              );
              if (undoStackRef.current[0]) undoIds.push(undoStackRef.current[0].id);
            }
            // Create/patch a lists.series entry (with the AO3 link already filled in, and the
            // real completion status when this came from a series page) for any series this
            // import touched, so you don't have to paste the link in manually afterward.
            if (seriesLinks && Object.keys(seriesLinks).length > 0) {
              const sourceCompleted = bulkImport?.sourceCompleted ?? null;
              const sourceDescription = bulkImport?.sourceDescription || "";
              Object.entries(seriesLinks).forEach(([name, link]) => {
                createOrPatchSeries(name, { link, description: sourceDescription, completed: sourceCompleted });
              });
            }
            setBulkImport(null);
            const dupNote = skippedDupCount > 0 ? ` (skipped ${skippedDupCount} already in your library)` : "";
            const parts = [];
            if (drafts.length > 0) parts.push(`added ${drafts.length} fic${drafts.length === 1 ? "" : "s"}`);
            if (refreshes && refreshes.length > 0) parts.push(`refreshed ${refreshes.length} fic${refreshes.length === 1 ? "" : "s"}`);
            const summary = parts.length > 0 ? parts.join(" and ") : "nothing changed";
            setToast({ kind: "ok", text: `${summary.charAt(0).toUpperCase() + summary.slice(1)}${dupNote}.`, undoIds });
          }}
        />
      )}
      {modal && (() => {
        const dup = findDuplicate(modal.draft, fics, modal.mode === "edit" ? modal.draft.id : null);
        return (
          <Modal title={modal.mode === "add" ? "Add a fic" : "Edit fic"} onClose={() => setModal(null)} onEnter={saveFromModal} wide>
            <FicForm
              draft={modal.draft}
              setDraft={(updater) => setModal((m) => ({ ...m, draft: typeof updater === "function" ? updater(m.draft) : updater }))}
              collections={lists.collections}
              seriesNames={seriesNames}
              onCreateCollection={quickCreateCollection}
              autoFetch={modal.autoFetch}
              uid={uid}
              onOpenSettings={() => { setModal(null); setSettingsOpen(true); }}
            />
            {dup && (
              <p className="ft-fetch-msg ft-fetch-warn" style={{ margin: "0 18px" }}>
                <AlertTriangle size={13} /> Already in your library: <strong>{dup.title}</strong> by {dup.author}.{" "}
                <button
                  type="button"
                  className="ft-pill"
                  style={{ marginLeft: 6 }}
                  onClick={() => {
                    const refreshed = refreshFicWithFreshData(dup, modal.draft);
                    persistFics((prev) => prev.map((f) => (f.id === dup.id ? refreshed : f)));
                    setModal(null);
                    setToast({ kind: "ok", text: `Refreshed "${dup.title}" with the latest from AO3 — word count, chapters, etc.` });
                  }}
                >
                  <RotateCcw size={12} /> Refresh its stats
                </button>{" "}
                <button type="button" className="ft-pill" onClick={() => setModal({ mode: "edit", draft: { ...dup } })}>
                  Open it instead
                </button>
              </p>
            )}
            <div className="ft-modal-footer">
              <button className="ft-btn ft-btn-ghost" onClick={() => setModal(null)}>Cancel</button>
              <button className="ft-btn ft-btn-primary" onClick={saveFromModal} disabled={!modal.draft.title.trim() || (!!dup && modal.mode === "add")}>
                {modal.mode === "add" ? "Add fic" : "Save changes"}
              </button>
            </div>
          </Modal>
        );
      })()}

      {csvImport && (
        <Modal
          title="Import from CSV"
          onClose={() => (csvImport.step !== "importing" && csvImport.step !== "parsing" ? setCsvImport(null) : null)}
        >
          {csvImport.step === "parsing" && (
            <p className="ft-fetch-msg"><Loader2 size={14} className="ft-spin" /> Reading the file…</p>
          )}

          {csvImport.step === "importing" && (
            <div>
              <ProgressBar pct={(csvImport.current / csvImport.total) * 100} color="var(--c-accent)" />
              <p className="ft-muted" style={{ marginTop: 6 }}>
                Adding fic {csvImport.current} of {csvImport.total}…
              </p>
            </div>
          )}

          {csvImport.step === "error" && (
            <>
              <p className="ft-fetch-msg ft-fetch-warn"><AlertTriangle size={13} /> {csvImport.error}</p>
              <div className="ft-modal-footer">
                <button className="ft-btn ft-btn-ghost" onClick={() => setCsvImport(null)}>Close</button>
              </div>
            </>
          )}

          {csvImport.step === "done" && (
            <>
              <p className="ft-fetch-msg ft-fetch-ok"><Check size={13} /> Added {csvImport.added} new fic{csvImport.added !== 1 ? "s" : ""}.</p>
              {csvImport.tagged > 0 && <p className="ft-muted">Tagged {csvImport.tagged} already in your library.</p>}
              {csvImport.shelves.length > 0 && <p className="ft-muted">Collections created/used: {csvImport.shelves.join(", ")}</p>}
              {csvImport.failed.length > 0 && (
                <div>
                  <p className="ft-fetch-msg ft-fetch-warn"><AlertTriangle size={13} /> Skipped {csvImport.failed.length} row{csvImport.failed.length !== 1 ? "s" : ""} (no title or unrecognized link):</p>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 160, overflowY: "auto" }}>
                    {csvImport.failed.map((item, idx) => {
                      const url = typeof item === "string" ? item : item.url;
                      const reason = typeof item === "string" ? null : item.reason;
                      return (
                        <li key={idx}>
                          <a href={url} target="_blank" rel="noreferrer" className="ft-muted">{url}</a>
                          {reason && <span className="ft-muted"> — {reason}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              <div className="ft-modal-footer">
                {csvImport.undoIds && csvImport.undoIds.length > 0 && (
                  <button
                    className="ft-btn ft-btn-ghost"
                    onClick={() => { csvImport.undoIds.forEach((id) => undoEntry(id)); setCsvImport(null); }}
                  >
                    <Undo2 size={14} /> Undo this import
                  </button>
                )}
                <button className="ft-btn ft-btn-primary" onClick={() => setCsvImport(null)}>Done</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {seriesImport && (
        <Modal
          title="Add from AO3 series"
          onClose={() => (seriesImport.step !== "fetching-works" && seriesImport.step !== "fetching-series" ? setSeriesImport(null) : null)}
        >
          {seriesImport.step === "input" && (
            <>
              <Field label="Series link" hint="e.g. https://archiveofourown.org/series/5590466">
                <input
                  value={seriesImportUrl}
                  onChange={(e) => setSeriesImportUrl(e.target.value)}
                  placeholder="https://archiveofourown.org/series/..."
                />
              </Field>
              <p className="ft-muted">This fetches the series name and every work in it, then adds whatever isn't already in your library.</p>
              <div className="ft-modal-footer">
                <button className="ft-btn ft-btn-ghost" onClick={() => setSeriesImport(null)}>Cancel</button>
                <button className="ft-btn ft-btn-primary" disabled={!seriesImportUrl.trim()} onClick={() => runSeriesImport(seriesImportUrl.trim())}>
                  Fetch series
                </button>
              </div>
            </>
          )}

          {seriesImport.step === "fetching-series" && (
            <p className="ft-fetch-msg"><Loader2 size={14} className="ft-spin" /> Looking up the series…</p>
          )}

          {seriesImport.step === "fetching-works" && (
            <div>
              <p><strong>{seriesImport.seriesName}</strong></p>
              <ProgressBar pct={(seriesImport.current / seriesImport.total) * 100} color="var(--c-accent)" />
              <p className="ft-muted" style={{ marginTop: 6 }}>
                Fetching {seriesImport.current} of {seriesImport.total}… this can take a little while for longer series.
              </p>
            </div>
          )}

          {seriesImport.step === "error" && (
            <>
              <p className="ft-fetch-msg ft-fetch-warn"><AlertTriangle size={13} /> {seriesImport.error}</p>
              <div className="ft-modal-footer">
                <button className="ft-btn ft-btn-ghost" onClick={() => setSeriesImport(null)}>Close</button>
                <button className="ft-btn ft-btn-primary" onClick={() => runSeriesImport(seriesImportUrl)}>
                  <RotateCcw size={14} /> Retry
                </button>
              </div>
            </>
          )}

          {seriesImport.step === "done" && (
            <>
              <p><strong>{seriesImport.seriesName}</strong></p>
              {seriesImport.partial && (
                <p className="ft-fetch-msg ft-fetch-warn">
                  <AlertTriangle size={13} /> AO3 slowed down partway through the series listing itself — this may not be every work in the series. Re-running the import is safe (it won't duplicate anything already added) and may pick up the rest.
                </p>
              )}
              <p className="ft-fetch-msg ft-fetch-ok"><Check size={13} /> Added {seriesImport.added} new fic{seriesImport.added !== 1 ? "s" : ""}.</p>
              {seriesImport.tagged > 0 && (
                <p className="ft-muted">Already had {seriesImport.tagged} of these — set their series name/position instead of adding duplicates.</p>
              )}
              {seriesImport.failed.length > 0 && (
                <div>
                  <p className="ft-fetch-msg ft-fetch-warn"><AlertTriangle size={13} /> Couldn't auto-fetch {seriesImport.failed.length} — add manually:</p>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                    {seriesImport.failed.map((u) => (
                      <li key={u}><a href={u} target="_blank" rel="noreferrer" className="ft-muted">{u}</a></li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="ft-modal-footer">
                <button className="ft-btn ft-btn-ghost" onClick={() => setSeriesImport(null)}>Done</button>
                {seriesImport.partial && (
                  <button className="ft-btn ft-btn-primary" onClick={() => runSeriesImport(seriesImportUrl)}>
                    <RotateCcw size={14} /> Run again
                  </button>
                )}
              </div>
            </>
          )}
        </Modal>
      )}

      {collectionPicker && (() => {
        const ficIds = collectionPicker.ficIds || [];
        const selected = collectionPicker.selected || [];
        return (
          <Modal title={collectionPicker.title} onClose={() => setCollectionPicker(null)}>
            <p className="ft-muted">{ficIds.length} fic{ficIds.length !== 1 ? "s" : ""} — pick one or more collections, or create a new one.</p>
            {lists.collections.length > 0 && (
              <div className="ft-checkrow">
                {lists.collections.map((c) => (
                  <label key={c.id} className="ft-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(c.id)}
                      onChange={() =>
                        setCollectionPicker((p) => {
                          const sel = p.selected || [];
                          return { ...p, selected: sel.includes(c.id) ? sel.filter((x) => x !== c.id) : [...sel, c.id] };
                        })
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            )}
            <div className="ft-fetchrow" style={{ marginTop: 8 }}>
              <input
                placeholder="New collection name…"
                value={collectionPicker.newName || ""}
                onChange={(e) => setCollectionPicker((p) => ({ ...p, newName: e.target.value }))}
              />
              <button
                type="button"
                className="ft-btn ft-btn-ghost"
                disabled={!collectionPicker.newName?.trim()}
                onClick={() => {
                  const c = quickCreateCollection(collectionPicker.newName.trim());
                  setCollectionPicker((p) => ({ ...p, selected: [...(p.selected || []), c.id], newName: "" }));
                }}
              >
                <Plus size={14} /> Create & select
              </button>
            </div>
            <div className="ft-modal-footer">
              <button className="ft-btn ft-btn-ghost" onClick={() => setCollectionPicker(null)}>Cancel</button>
              <button
                className="ft-btn ft-btn-primary"
                disabled={selected.length === 0}
                onClick={() => {
                  const itemIds = new Set(ficIds);
                  persistFics((prev) =>
                    prev.map((f) => {
                      if (!itemIds.has(f.id)) return f;
                      const cols = new Set(f.collections || []);
                      selected.forEach((id) => cols.add(id));
                      return { ...f, collections: Array.from(cols) };
                    })
                  );
                  setCollectionPicker(null);
                }}
              >
                Add {ficIds.length} fic{ficIds.length !== 1 ? "s" : ""} to {selected.length} collection{selected.length !== 1 ? "s" : ""}
              </button>
            </div>
          </Modal>
        );
      })()}

      {seriesModal && (
        <Modal title={lists.series.some((s) => s.id === seriesModal.id) ? "Edit series" : "New series"} onClose={() => setSeriesModal(null)}>
          <Field label="Name"><input value={seriesModal.name} onChange={(e) => setSeriesModal({ ...seriesModal, name: e.target.value })} /></Field>
          <Field label="AO3 series link (optional)" hint="lets you click the series name to open it on AO3">
            <input
              value={seriesModal.link || ""}
              onChange={(e) => setSeriesModal({ ...seriesModal, link: e.target.value })}
              placeholder="https://archiveofourown.org/series/..."
            />
          </Field>
          <Field label="Description (optional)"><textarea rows={2} value={seriesModal.description} onChange={(e) => setSeriesModal({ ...seriesModal, description: e.target.value })} /></Field>
          <label className="ft-check">
            <input
              type="checkbox"
              checked={!!seriesModal.completed}
              onChange={(e) => setSeriesModal({ ...seriesModal, completed: e.target.checked })}
            />
            This series is complete
          </label>
          <p className="ft-muted">After creating it, pick this name from the "Series name" field when adding or editing a fic to add it here.</p>
          <div className="ft-modal-footer">
            <button className="ft-btn ft-btn-ghost" onClick={() => setSeriesModal(null)}>Cancel</button>
            <button className="ft-btn ft-btn-primary" disabled={!seriesModal.name.trim()} onClick={() => saveSeriesItem(seriesModal)}>Save</button>
          </div>
        </Modal>
      )}

      {collectionModal && (
        <Modal title={lists.collections.some((c) => c.id === collectionModal.id) ? "Edit collection" : "New collection"} onClose={() => setCollectionModal(null)}>
          <Field label="Name"><input value={collectionModal.name} onChange={(e) => setCollectionModal({ ...collectionModal, name: e.target.value })} /></Field>
          <Field label="Description (optional)"><textarea rows={2} value={collectionModal.description} onChange={(e) => setCollectionModal({ ...collectionModal, description: e.target.value })} /></Field>
          <div className="ft-modal-footer">
            <button className="ft-btn ft-btn-ghost" onClick={() => setCollectionModal(null)}>Cancel</button>
            <button className="ft-btn ft-btn-primary" disabled={!collectionModal.name.trim()} onClick={() => saveCollection(collectionModal)}>Save</button>
          </div>
        </Modal>
      )}

      {authorModal && (
        <Modal title={lists.favoriteAuthors.some((a) => a.id === authorModal.id) ? "Edit author" : "Add favorite author"} onClose={() => setAuthorModal(null)}>
          <Field label="Name"><input value={authorModal.name} onChange={(e) => setAuthorModal({ ...authorModal, name: e.target.value })} /></Field>
          <div className="ft-form-grid">
            <Field label="Platform">
              <select value={authorModal.platform} onChange={(e) => setAuthorModal({ ...authorModal, platform: e.target.value })}>
                {["AO3", "FFN", "Wattpad", "Tumblr", "Other"].map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Profile link"><input value={authorModal.link} onChange={(e) => setAuthorModal({ ...authorModal, link: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><textarea rows={2} value={authorModal.notes} onChange={(e) => setAuthorModal({ ...authorModal, notes: e.target.value })} /></Field>
          <div className="ft-modal-footer">
            <button className="ft-btn ft-btn-ghost" onClick={() => setAuthorModal(null)}>Cancel</button>
            <button className="ft-btn ft-btn-primary" disabled={!authorModal.name.trim()} onClick={() => saveAuthor(authorModal)}>Save</button>
          </div>
        </Modal>
      )}

      {settingsOpen && (
        <Modal title="Settings & backup" onClose={() => setSettingsOpen(false)}>
          <p className="ft-muted">
            Signed in as <strong>{userEmail}</strong>. Your library syncs automatically to this account —
            sign in with the same email on another device to see the same data there.
          </p>
          <div className="ft-settings-row">
            <button className="ft-btn ft-btn-ghost" onClick={onSignOut}><LogOut size={14} /> Sign out</button>
          </div>
          <AO3CredentialsSection uid={uid} />
          <div className="ft-settings-row" style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>Add a fic straight from AO3</strong>
              <HelpTooltip>
                Drag the button to your bookmarks bar. While you're on a fic's AO3 page, click it —
                it reads the title, fandoms, rating, word count, etc. straight off the page you're
                already viewing (no extra request to AO3, so this should work even when AO3 is
                struggling) and opens this app with the Add form filled in. Just review and hit Save.
                On iPhone, Safari won't let you drag this in directly — bookmark this settings page
                first, then edit that bookmark and paste the button's link in as its URL.
              </HelpTooltip>
            </div>
            <a
              href={addBookmarkletHref}
              className="ft-btn ft-btn-primary"
              onClick={(e) => e.preventDefault()}
              title="Drag this to your bookmarks bar — don't click it here"
            >
              <Plus size={14} /> Add to Library
            </a>
            <p className="ft-muted" style={{ marginTop: 6 }}>Drag, don't click — this only does something on an AO3 work page.</p>
          </div>
          <div className="ft-settings-row" style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>Add a whole series or collection</strong>
              <HelpTooltip>
                Drag to your bookmarks bar. Works on AO3 series pages, collection bookmarks pages, collection works pages,
                search results, and tag pages — anywhere AO3 shows a list of work blurbs. Click it on the page and it reads
                every visible work (no request to AO3) and opens a bulk-import review panel here so you can confirm before
                anything is saved. Paginated pages only import the current page — click page by page to import more.
              </HelpTooltip>
            </div>
            <a
              href={addBulkBookmarkletHref}
              className="ft-btn ft-btn-primary"
              onClick={(e) => e.preventDefault()}
              title="Drag this to your bookmarks bar — don't click it here"
            >
              <Inbox size={14} /> Add Page to Library
            </a>
            <p className="ft-muted" style={{ marginTop: 6 }}>Drag, don't click — use on any AO3 page listing multiple works.</p>
          </div>
          <div className="ft-settings-row" style={{ display: "block" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>Update reading progress</strong>
              <HelpTooltip>
                Drag to your bookmarks bar. While reading a fic on AO3 (in chapter-by-chapter view —
                Preferences on AO3, uncheck "Show entire work at once"), click it on whichever chapter
                you're currently on. It matches the fic by AO3 link, sets your reading progress to that
                chapter, and saves the exact chapter link so the fic's title in your library opens back
                to right where you left off. Marking a fic Completed resets that link back to the start
                for next time; marking it Caught Up leaves it where it is, since the fic itself isn't
                done. Only updates fics already in your library — add it first if it isn't there yet.
              </HelpTooltip>
            </div>
            <a
              href={updateProgressBookmarkletHref}
              className="ft-btn ft-btn-primary"
              onClick={(e) => e.preventDefault()}
              title="Drag this to your bookmarks bar — don't click it here"
            >
              <BookOpen size={14} /> Update Progress
            </a>
            <p className="ft-muted" style={{ marginTop: 6 }}>Drag, don't click — click it on AO3 while reading a specific chapter.</p>
          </div>
          <div className="ft-settings-row">
            <button className="ft-btn ft-btn-ghost" onClick={exportData}><Download size={14} /> Export JSON</button>
            <label className="ft-btn ft-btn-ghost ft-filelabel">
              <Upload size={14} /> Import JSON
              <input type="file" accept="application/json" onChange={importData} hidden />
            </label>
            <label className="ft-btn ft-btn-ghost ft-filelabel">
              <Upload size={14} /> Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) runCsvImport(file);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="ft-muted">CSV needs a "link" (or "url") column — AO3 work/series/collection links all work. An optional "source"/"shelf" column becomes a Collection.</p>
          <div className="ft-settings-row">
            <button
              className="ft-btn ft-btn-danger"
              onClick={() => {
                const n = fics.length;
                if (confirm(`Move all ${n} fic${n !== 1 ? "s" : ""} to Trash (recoverable for 30 days) and permanently delete every collection/series/author you've saved (not recoverable)? Consider exporting a backup first.`)) clearAll();
              }}
            >
              <Trash2 size={14} /> Clear all data
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Auth screen                                                        */
/* ---------------------------------------------------------------- */

function AuthScreen() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "signup") {
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
    } catch (err) {
      setError(err.message.replace("Firebase: ", ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ft-auth-wrap">
      <style>{CSS}</style>
      <form className="ft-auth-card" onSubmit={submit}>
        <div className="ft-brand ft-auth-brand"><BookOpen size={20} /> Fic Tracker</div>
        <h2>{mode === "signup" ? "Create your library" : "Welcome back"}</h2>
        <p className="ft-muted">
          {mode === "signup"
            ? "One account, synced everywhere you sign in."
            : "Sign in to pick up your library where you left off."}
        </p>
        <Field label="Email">
          <div className="ft-fetchrow">
            <Mail size={14} className="ft-auth-icon" />
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
        </Field>
        <Field label="Password">
          <div className="ft-fetchrow">
            <Lock size={14} className="ft-auth-icon" />
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </div>
        </Field>
        {error && <p className="ft-fetch-msg ft-fetch-warn"><AlertTriangle size={13} /> {error}</p>}
        <button className="ft-btn ft-btn-primary ft-auth-submit" type="submit" disabled={busy}>
          {busy ? <Loader2 size={14} className="ft-spin" /> : null}
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
        <button type="button" className="ft-btn ft-btn-ghost ft-auth-switch" onClick={() => setMode(mode === "signup" ? "signin" : "signup")}>
          {mode === "signup" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
      </form>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Top-level app: gates between sign-in and the tracker                */
/* ---------------------------------------------------------------- */

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out

  useEffect(() => watchAuth(setUser), []);

  if (user === undefined) {
    return (
      <div className="ft-root ft-loading">
        <style>{CSS}</style>
        <Loader2 size={22} className="ft-spin" />
        <span>Checking your account…</span>
      </div>
    );
  }

  if (!user) return <AuthScreen />;

  return <Tracker uid={user.uid} userEmail={user.email} onSignOut={signOutUser} />;
}

function ChartBlock({ title, data, color }) {
  return (
    <div className="ft-chart-card">
      <h4>{title}</h4>
      {data.length === 0 ? (
        <p className="ft-muted">Not enough data yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
            <CartesianGrid horizontal={false} stroke="var(--c-border)" />
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" width={110} tick={{ fill: "var(--c-text-muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={{ background: "var(--c-surface-raised)", border: "1px solid var(--c-border)", color: "var(--c-text)", fontSize: 12 }} />
            <Bar dataKey="count" fill={color} radius={[0, 4, 4, 0]} barSize={14} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* Styles                                                             */
/* ---------------------------------------------------------------- */

const CSS = `
html { scrollbar-gutter: stable; }
.ft-root {
  --c-bg: #111111;
  --c-surface: #1a1a1a;
  --c-surface-raised: #262626;
  --c-border: #333333;
  --c-text: #f2f2f2;
  --c-text-muted: #aaaaaa;
  --c-muted: #777777;
  --c-accent: #970000;
  --c-rose: #d6595a;
  --c-sage: #98d659;
  --c-gold: #d6a23c;
  --c-blue: #5998d6;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  width: 100%;
}
.ft-loading { align-items: center; justify-content: center; gap: 10px; flex-direction: row; padding: 40px; color: var(--c-text-muted); }
.ft-spin { animation: ft-spin 1s linear infinite; }
@keyframes ft-spin { to { transform: rotate(360deg); } }

.ft-nav {
  width: 100%;
  flex-shrink: 0;
  background: var(--c-accent);
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;
  padding: 10px 36px 10px 14px;
  padding-top: calc(10px + env(safe-area-inset-top, 0px));
  gap: 6px;
  position: sticky;
  top: 0;
  z-index: 40;
}
.ft-brand { font-weight: 800; font-size: 16px; display: flex; align-items: center; gap: 8px; padding: 0; color: #fff; margin-right: 4px; flex-shrink: 0; }
.ft-nav-items {
  display: flex; flex-direction: row; align-items: center; gap: 0;
  flex-shrink: 1; min-width: 0; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none; -ms-overflow-style: none;
}
.ft-nav-items::-webkit-scrollbar { display: none; }
.ft-nav-item {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 9px; border-radius: 6px; border: none; background: transparent;
  color: rgba(255,255,255,0.75); font-size: 13px; cursor: pointer; text-align: left;
  border-bottom: 3px solid transparent; white-space: nowrap; flex-shrink: 0;
}
.ft-nav-item:hover { background: rgba(255,255,255,0.08); color: #fff; }
.ft-nav-item-active { background: transparent; color: #fff; border-bottom-color: #fff; }
.ft-nav-actions { display: flex; align-items: center; gap: 1px; flex-shrink: 0; margin-left: auto; }
.ft-nav-settings { flex-shrink: 0; color: rgba(255,255,255,0.85) !important; }
.ft-nav-settings:hover { background: rgba(255,255,255,0.12) !important; color: #fff !important; }
@media (max-width: 640px) {
  .ft-nav { padding: 8px 10px 8px 6px; padding-top: calc(8px + env(safe-area-inset-top, 0px)); gap: 4px; }
  .ft-brand span { display: none; }
  .ft-brand { margin-right: 2px; }
  .ft-nav-item { padding: 6px 8px; font-size: 12px; gap: 4px; }
  .ft-nav-item span { display: none; }
  .ft-nav-actions { gap: 0; }
  .ft-nav-actions .ft-iconbtn { padding: 4px; }
}
.ft-trash-badge {
  position: absolute; top: -2px; right: -2px; background: var(--c-rose); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 1; border-radius: 999px;
  min-width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; padding: 0 3px;
}

.ft-main { flex: 1; padding: 20px 24px 40px; overflow-y: auto; overflow-x: hidden; min-width: 0; }

.ft-topbar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
.ft-search { flex: 1; min-width: 180px; display: flex; align-items: center; gap: 8px; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 8px; padding: 8px 12px; color: var(--c-text-muted); }
.ft-search input { background: transparent; border: none; outline: none; color: var(--c-text); width: 100%; font-size: 13px; }

.ft-filterbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.ft-filterbar select, .ft-filter-input {
  background: var(--c-surface); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: 6px; padding: 7px 10px; font-size: 12.5px;
}
.ft-filter-input { min-width: 140px; }

.ft-multiselect { position: relative; }
.ft-multiselect-trigger {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  cursor: pointer; min-width: 170px; color: var(--c-text); text-align: left; font-family: inherit;
}
.ft-multiselect-trigger span { color: var(--c-text-muted); }
.ft-multiselect-panel {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 25; width: 260px;
  background: var(--c-surface-raised); border: 1px solid var(--c-border); border-radius: 8px;
  box-shadow: 0 10px 28px rgba(0,0,0,0.5); display: flex; flex-direction: column; overflow: hidden;
}
.ft-multiselect-search {
  border: none; border-bottom: 1px solid var(--c-border); background: transparent; color: var(--c-text);
  padding: 9px 12px; font-size: 12.5px; outline: none;
}
.ft-multiselect-list { max-height: 220px; overflow-y: auto; padding: 4px; }
.ft-multiselect-option {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px;
  font-size: 12.5px; color: var(--c-text); cursor: pointer;
}
.ft-multiselect-option:hover { background: var(--c-surface); }
.ft-multiselect-empty { padding: 10px 12px; font-size: 12px; color: var(--c-text-muted); }
.ft-multiselect-clear {
  border: none; border-top: 1px solid var(--c-border); background: transparent; color: var(--c-rose);
  padding: 8px 12px; font-size: 12px; cursor: pointer; text-align: left;
}
.ft-multiselect-clear:hover { background: var(--c-surface); }
.ft-multiselect-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; max-width: 260px; }
.ft-multiselect-chip { display: inline-flex; align-items: center; gap: 4px; }
.ft-multiselect-chip button { display: flex; background: none; border: none; color: inherit; cursor: pointer; padding: 0; opacity: 0.7; }
.ft-multiselect-chip button:hover { opacity: 1; }

.ft-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }

.ft-card {
  background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px;
  padding: 14px; display: flex; flex-direction: column; gap: 9px;
}
.ft-card-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.ft-card-title { font-weight: 700; font-size: 15px; color: var(--c-text); text-decoration: none; line-height: 1.3; }
.ft-card-title:hover { color: var(--c-accent); }
.ft-card-author { font-size: 11.5px; color: var(--c-text-muted); margin-top: 2px; }
.ft-card-actions { display: flex; gap: 3px; flex-shrink: 0; }

.ft-chiprow { display: flex; gap: 5px; flex-wrap: wrap; }
.ft-chip { font-size: 10.5px; background: var(--c-surface-raised); color: var(--c-text-muted); border-radius: 4px; padding: 2px 7px; }
.ft-chip-ship { color: var(--c-rose); }
.ft-chip-series { color: var(--c-gold); display: inline-flex; align-items: center; gap: 3px; font-weight: 600; }

.ft-card-meta { display: flex; gap: 6px; flex-wrap: wrap; }
.ft-badge { font-size: 10px; font-weight: 600; letter-spacing: 0.02em; padding: 2px 7px; border-radius: 10px; color: var(--bc); background: color-mix(in srgb, var(--bc) 18%, transparent); border: 1px solid color-mix(in srgb, var(--bc) 45%, transparent); }

.ft-progress-track { height: 5px; border-radius: 3px; background: var(--c-surface-raised); overflow: hidden; }
.ft-progress-fill { height: 100%; border-radius: 3px; }
.ft-card-progress { display: flex; flex-direction: column; gap: 4px; }
.ft-card-progress-label { font-size: 10.5px; color: var(--c-text-muted); font-family: ui-monospace, monospace; }
.ft-card-bottom { display: flex; justify-content: space-between; align-items: flex-end; gap: 8px; }
.ft-card-dates { font-size: 10.5px; color: var(--c-text-muted); white-space: nowrap; }
.ft-card-quickrow { display: flex; gap: 6px; flex-wrap: wrap; }

.ft-pill {
  font-size: 11px; background: var(--c-surface-raised); border: 1px solid var(--c-border); color: var(--c-text);
  border-radius: 20px; padding: 5px 10px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
}
.ft-pill-danger { border-color: var(--c-rose); color: var(--c-rose); }
.ft-pill-danger:hover { background: color-mix(in srgb, var(--c-rose) 15%, transparent); }
.ft-bulkbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: var(--c-surface-raised); border: 1px solid var(--c-border); border-radius: 8px;
  padding: 8px 12px; margin-bottom: 12px;
}
.ft-pill:hover { border-color: var(--c-accent); color: var(--c-accent); }

.ft-iconbtn { background: transparent; border: none; color: var(--c-text-muted); cursor: pointer; padding: 5px; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
.ft-iconbtn:hover { background: var(--c-surface-raised); color: var(--c-text); }
.ft-iconbtn-danger-active { color: var(--c-rose); background: color-mix(in srgb, var(--c-rose) 20%, transparent); }

.ft-btn {
  display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500;
  padding: 8px 14px; border-radius: 7px; border: 1px solid var(--c-border); background: var(--c-surface);
  color: var(--c-text); cursor: pointer; white-space: nowrap;
}
.ft-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ft-btn-primary { background: var(--c-accent); color: #fff; border-color: var(--c-accent); }
.ft-btn-primary:hover:not(:disabled) { filter: brightness(1.15); }
.ft-btn-ghost:hover { background: var(--c-surface-raised); }
.ft-btn-danger { color: var(--c-rose); border-color: var(--c-rose); }
.ft-btn-danger:hover { background: color-mix(in srgb, var(--c-rose) 15%, transparent); }
.ft-filelabel { cursor: pointer; }

.ft-section { max-width: 980px; }
.ft-section h1 { font-size: 22px; margin: 0 0 16px; }
.ft-section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; row-gap: 10px; }
.ft-section-head h1 { margin: 0; }
.ft-section-head .ft-card-actions { flex-wrap: wrap; flex-shrink: 1; }
@media (max-width: 640px) {
  .ft-section-head .ft-card-actions { width: 100%; }
  .ft-section-head .ft-card-actions .ft-filter-input,
  .ft-section-head .ft-card-actions select { flex: 1 1 auto; min-width: 0; }
}
.ft-muted { color: var(--c-text-muted); font-size: 12.5px; }

.ft-series-block { margin-bottom: 26px; }
.ft-select-overlay {
  position: absolute; top: 8px; left: 8px; z-index: 5;
  background: var(--c-surface-raised); border: 1px solid var(--c-border); border-radius: 6px;
  padding: 4px; display: flex; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.ft-select-overlay input { width: 18px; height: 18px; cursor: pointer; margin: 0; }
.ft-series-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.ft-series-head h3 { font-size: 16px; margin: 0; color: var(--c-accent); }

.ft-author-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }

.ft-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 22px; }
.ft-stat-card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 2px; }
.ft-stat-num { font-size: 22px; font-weight: 700; color: var(--c-accent); }
.ft-stat-card span:last-child { font-size: 11.5px; color: var(--c-text-muted); }

.ft-chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-bottom: 26px; }
.ft-chart-card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 10px; padding: 14px; }
.ft-chart-card h4 { margin: 0 0 8px; font-size: 13px; color: var(--c-text-muted); font-weight: 600; }

.ft-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: var(--c-text-muted); padding: 50px 20px; border: 1px dashed var(--c-border); border-radius: 12px; grid-column: 1 / -1; }
.ft-empty h3 { color: var(--c-text); margin: 4px 0 0; }
.ft-empty p { margin: 0; max-width: 320px; font-size: 13px; }

.ft-modal-backdrop { position: fixed; inset: 0; background: rgba(8, 10, 14, 0.7); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
.ft-modal { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 12px; width: 100%; max-width: 460px; max-height: 88vh; display: flex; flex-direction: column; color: var(--c-text); }
.ft-modal-wide { max-width: 640px; }
.ft-modal-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--c-border); }
.ft-modal-head h2 { font-size: 17px; margin: 0; }
.ft-modal-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }
.ft-modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px; border-top: 1px solid var(--c-border); }

.ft-form { display: flex; flex-direction: column; gap: 12px; }
.ft-form-section { background: var(--c-surface-raised); border-radius: 8px; padding: 10px 12px; }
.ft-fetchbox { border: 1px solid var(--c-border); }
.ft-fetchrow { display: flex; gap: 8px; }
.ft-fetchrow input { flex: 1; }
.ft-fetch-msg { display: flex; align-items: center; gap: 6px; font-size: 12px; margin: 6px 0 0; }
.ft-fetch-ok { color: var(--c-sage); }
.ft-fetch-warn { color: var(--c-accent); }

.ft-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.ft-form-grid-3 { grid-template-columns: 1fr 1fr 1fr; }

.ft-field { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--c-text-muted); }
.ft-field-label { font-weight: 600; }
.ft-field-hint { font-size: 10.5px; opacity: 0.8; }
.ft-field input, .ft-field select, .ft-field textarea {
  background: var(--c-surface-raised); border: 1px solid var(--c-border); border-radius: 6px;
  padding: 7px 10px; color: var(--c-text); font-size: 13px; font-family: inherit; resize: vertical;
}
.ft-field input:focus, .ft-field select:focus, .ft-field textarea:focus { outline: 2px solid var(--c-accent); outline-offset: 1px; }

.ft-checkrow { display: flex; flex-direction: column; gap: 6px; }
.ft-check { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--c-text); font-weight: 400; }
.ft-radio-card {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--c-border); background: var(--c-surface-raised); cursor: pointer; font-size: 13px;
}
.ft-radio-card input[type="radio"] { margin-top: 3px; flex-shrink: 0; }

.ft-settings-row { display: flex; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }

.ft-tooltip { position: relative; display: inline-flex; align-items: center; color: var(--c-text-muted); cursor: help; outline: none; }
.ft-tooltip:hover, .ft-tooltip:focus { color: var(--c-accent); }
.ft-tooltip-bubble {
  position: absolute; bottom: 135%; left: 0; transform: translateX(-10%);
  background: var(--c-surface-raised); border: 1px solid var(--c-border); color: var(--c-text);
  padding: 10px 12px; border-radius: 8px; font-size: 12px; line-height: 1.45; width: 260px;
  opacity: 0; visibility: hidden; transition: opacity 0.12s ease; z-index: 30; pointer-events: none;
  box-shadow: 0 8px 20px rgba(0,0,0,0.45);
}
.ft-tooltip:hover .ft-tooltip-bubble, .ft-tooltip:focus .ft-tooltip-bubble { opacity: 1; visibility: visible; }

.ft-toast {
  position: fixed; top: 16px; right: 16px; max-width: 320px; z-index: 60;
  background: var(--c-surface-raised); border: 1px solid var(--c-border); border-left: 4px solid var(--c-sage);
  border-radius: 8px; padding: 12px 14px; display: flex; align-items: flex-start; gap: 8px;
  font-size: 13px; box-shadow: 0 10px 28px rgba(0,0,0,0.5);
}
.ft-toast-warn { border-left-color: var(--c-accent); }

.ft-auth-wrap { min-height: 100vh; width: 100%; display: flex; align-items: center; justify-content: center; background: var(--c-bg); color: var(--c-text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; }
.ft-auth-card { background: var(--c-surface); border: 1px solid var(--c-border); border-radius: 14px; padding: 28px 26px; width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 12px; }
.ft-auth-brand { padding: 0; border: none; margin-bottom: 0; color: var(--c-accent); }
.ft-auth-card h2 { margin: 4px 0 0; font-size: 19px; }
.ft-auth-card .ft-muted { margin: 0 0 6px; }
.ft-auth-icon { color: var(--c-text-muted); flex-shrink: 0; align-self: center; }
.ft-auth-submit { justify-content: center; margin-top: 4px; }
.ft-auth-switch { justify-content: center; }

@media (max-width: 720px) {
  .ft-main { padding: 14px 14px 30px; }
  .ft-form-grid, .ft-form-grid-3 { grid-template-columns: 1fr; }
}
`;
