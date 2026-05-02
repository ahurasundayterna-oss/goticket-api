/**
 * services/nlp.js
 *
 * Rule-based Natural Language Understanding for GoTicket WhatsApp bot.
 * No external APIs or paid services — pure regex + keyword matching.
 *
 * Exports:
 *   parseIntent(text)  → { intent, from, to, date, seats } | null
 *   resolveDate(text)  → Date | null   (handles "today", "tomorrow", DD-MM-YYYY)
 *
 * Supported free-text patterns (case-insensitive):
 *   "I want to travel tomorrow from Makurdi to Abuja"
 *   "book gboko to makurdi"
 *   "any trip today from Lagos to Kano"
 *   "2 seats Lagos - Abuja 25-04-2026"
 *   "check my booking GT-A3K7RX"
 *   "cancel"
 */

"use strict";

/* ── Known Nigerian cities / transport hubs ──────────────────────────────── */
const KNOWN_CITIES = [
  "lagos", "abuja", "kano", "ibadan", "kaduna", "port harcourt", "benin",
  "maiduguri", "zaria", "aba", "jos", "ilorin", "oyo", "enugu", "abeokuta",
  "onitsha", "warri", "sokoto", "calabar", "uyo", "asaba", "akure", "bauchi",
  "makurdi", "gboko", "otukpo", "lafia", "nasarawa", "lokoja", "minna",
  "birnin kebbi", "gusau", "dutse", "damaturu", "jalingo", "yola", "gombe",
  "awka", "owerri", "umuahia", "abakaliki", "ekiti", "ado ekiti", "ikeja",
  "surulere", "wuse", "garki", "nyanya", "kubwa", "lugbe",
];

/* ── Connectors that separate origin from destination ────────────────────── */
const ROUTE_CONNECTORS = /\s+(?:to|[-–—])\s+/i;

/* ── Date relative keywords ──────────────────────────────────────────────── */
const TODAY_WORDS    = /\b(today|now|tonight)\b/i;
const TOMORROW_WORDS = /\b(tomorrow|tmr|tmrw)\b/i;
const DAYAFTER_WORDS = /\b(day after tomorrow|overmorrow)\b/i;

/* ── Explicit date formats ───────────────────────────────────────────────── */
const DATE_DMY = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/;
const DATE_YMD = /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/;

/* ── Seat count patterns ─────────────────────────────────────────────────── */
const SEAT_PATTERNS = [
  /\b(\d+)\s+(?:seat|seats|ticket|tickets|person|persons|people|passenger|passengers)\b/i,
  /\b(?:for|booking)\s+(\d+)\b/i,
];

/* ── Intent keywords ─────────────────────────────────────────────────────── */
const BOOK_WORDS   = /\b(book|reserve|get|buy|travel|trip|journey|ride|going|i want|i need|take me)\b/i;
const CHECK_WORDS  = /\b(check|find|lookup|status|where is|track|my booking)\b/i;
const CANCEL_WORDS = /\b(cancel|stop|abort)\b/i;
const MENU_WORDS   = /\b(menu|start|restart|hi|hello|hey|back|home)\b/i;

/* ══════════════════════════════════════════════════════════════════════════
   WAT HELPERS
   ──────────────────────────────────────────────────────────────────────────
   All date comparisons and "today/tomorrow" resolution use Africa/Lagos
   (WAT = UTC+1) so the bot behaves correctly regardless of the server's
   system timezone (e.g. UTC on most cloud hosts).
══════════════════════════════════════════════════════════════════════════ */

/**
 * Returns a Date anchored to WAT midnight (00:00:00 +01:00) for today.
 * @returns {Date}
 */
function getTodayWAT() {
  const str = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  return new Date(`${str}T00:00:00+01:00`);
}

/**
 * Returns a Date anchored to WAT midnight for tomorrow.
 * @returns {Date}
 */
function getTomorrowWAT() {
  const d = getTodayWAT();
  d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Returns a Date anchored to WAT midnight N days from today.
 * @param {number} n
 * @returns {Date}
 */
function getWATDateOffset(n) {
  const d = getTodayWAT();
  d.setDate(d.getDate() + n);
  return d;
}

/* ══════════════════════════════════════════════════════════════════════════
   resolveDate
   ──────────────────────────────────────────────────────────────────────────
   Converts a relative or absolute date string to a WAT-anchored Date.
   Returns null for unrecognised or past dates.
══════════════════════════════════════════════════════════════════════════ */
function resolveDate(text) {
  const t       = (text || "").trim();
  const todayWAT = getTodayWAT();

  if (TODAY_WORDS.test(t))    return getTodayWAT();
  if (TOMORROW_WORDS.test(t)) return getTomorrowWAT();
  if (DAYAFTER_WORDS.test(t)) return getWATDateOffset(2);

  // DD-MM-YYYY or DD/MM/YYYY or DD-MM-YY
  let m = DATE_DMY.exec(t);
  if (m) {
    const fullYear = m[3].length === 2 ? "20" + m[3] : m[3];
    const date = new Date(
      `${fullYear}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}T00:00:00+01:00`
    );
    if (!isNaN(date.getTime()) && date >= todayWAT) return date;
    return null;
  }

  // YYYY-MM-DD
  m = DATE_YMD.exec(t);
  if (m) {
    const date = new Date(
      `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}T00:00:00+01:00`
    );
    if (!isNaN(date.getTime()) && date >= todayWAT) return date;
    return null;
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   extractCity
══════════════════════════════════════════════════════════════════════════ */
function extractCity(token) {
  const lower = token.trim().toLowerCase();
  if (!lower || lower.length < 2) return null;

  const NOISE = new Set([
    "a","an","the","i","my","me","we","us","our","from","to","at","in","on",
    "and","or","for","of","is","are","was","were","be","been","have","has",
    "want","need","book","reserve","any","some","trip","trips","seat","seats",
    "today","tomorrow","now","please","thanks","okay","ok","yes","no","hi",
    "hello","hey","going","travel","travelling","traveling","journey","ride",
    "ticket","tickets","passenger","passengers","person","people",
  ]);

  if (NOISE.has(lower)) return null;

  for (const city of KNOWN_CITIES) {
    if (lower === city || lower.startsWith(city) || lower.endsWith(city)) {
      return city.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
    }
  }

  if (lower.length >= 3 && !/^\d+$/.test(lower)) {
    return token.trim().split(" ")
      .map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   parseIntent
══════════════════════════════════════════════════════════════════════════ */
function parseIntent(rawText) {
  const text  = (rawText || "").trim();
  const lower = text.toLowerCase();

  const result = {
    intent: "UNKNOWN",
    from:   null,
    to:     null,
    date:   null,
    seats:  null,
    ref:    null,
  };

  /* ── Intent ── */
  if (MENU_WORDS.test(lower))   { result.intent = "MENU";   return result; }
  if (CANCEL_WORDS.test(lower)) { result.intent = "CANCEL"; return result; }

  const refMatch = /\b(GT-[A-Z0-9]{5,8})\b/i.exec(text);
  if (refMatch) {
    result.intent = "CHECK";
    result.ref    = refMatch[1].toUpperCase();
    return result;
  }

  if (CHECK_WORDS.test(lower)) result.intent = "CHECK";
  if (BOOK_WORDS.test(lower))  result.intent = "BOOK";

  /* ── Date ── */
  result.date = resolveDate(lower);

  /* ── Seat count ── */
  for (const pattern of SEAT_PATTERNS) {
    const m = pattern.exec(lower);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 10) { result.seats = n; break; }
    }
  }

  /* ── Route: strategy 1 — "from X to Y" ── */
  const fromTo = /\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+on|\s+\d|\s+today|\s+tomorrow|$)/i.exec(text);
  if (fromTo) {
    const maybeFrom = extractCity(fromTo[1]);
    const maybeTo   = extractCity(fromTo[2]);
    if (maybeFrom) result.from = maybeFrom;
    if (maybeTo)   result.to   = maybeTo;
  }

  /* ── Route: strategy 2 — "X to Y" or "X - Y" ── */
  if (!result.from || !result.to) {
    const stripped = text
      .replace(/\b(book|reserve|get|i want|i need|any trip|a trip|travel|going)\b/gi, "")
      .replace(/\b(today|tomorrow|tmr|now|tonight|day after tomorrow)\b/gi, "")
      .replace(DATE_DMY, "")
      .replace(DATE_YMD, "")
      .replace(/\b\d+\s*(seat|seats|ticket|tickets|person|people)\b/gi, "")
      .trim();

    const parts = stripped.split(ROUTE_CONNECTORS).map(p => p.trim()).filter(Boolean);

    if (parts.length >= 2) {
      const maybeFrom = extractCity(parts[0]);
      const maybeTo   = extractCity(parts[parts.length - 1]);
      if (!result.from && maybeFrom) result.from = maybeFrom;
      if (!result.to   && maybeTo)   result.to   = maybeTo;
    }
  }

  if (result.intent === "UNKNOWN" && (result.from || result.to)) {
    result.intent = "BOOK";
  }

  return result;
}

module.exports = { parseIntent, resolveDate, getTodayWAT, getTomorrowWAT };