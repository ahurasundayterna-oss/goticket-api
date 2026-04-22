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
// Used to disambiguate city names from noise words.
// Extend this list as your routes grow.
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
const TODAY_WORDS     = /\b(today|now|tonight)\b/i;
const TOMORROW_WORDS  = /\b(tomorrow|tmr|tmrw)\b/i;
const DAYAFTER_WORDS  = /\b(day after tomorrow|overmorrow)\b/i;

/* ── Explicit date formats: DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD ───────────── */
const DATE_DMY  = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/;
const DATE_YMD  = /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/;

/* ── Seat count patterns ─────────────────────────────────────────────────── */
const SEAT_PATTERNS = [
  /\b(\d+)\s+(?:seat|seats|ticket|tickets|person|persons|people|passenger|passengers)\b/i,
  /\b(?:for|booking)\s+(\d+)\b/i,
];

/* ── Intent keywords ─────────────────────────────────────────────────────── */
const BOOK_WORDS  = /\b(book|reserve|get|buy|travel|trip|journey|ride|going|i want|i need|take me)\b/i;
const CHECK_WORDS = /\b(check|find|lookup|status|where is|track|my booking)\b/i;
const CANCEL_WORDS= /\b(cancel|stop|abort)\b/i;
const MENU_WORDS  = /\b(menu|start|restart|hi|hello|hey|back|home)\b/i;

/* ══════════════════════════════════════════════════════════════════════════ */

/**
 * Resolve a relative or absolute date string to a Date object.
 * Returns null for invalid or past dates.
 *
 * @param {string} text
 * @returns {Date|null}
 */
function resolveDate(text) {
  const t   = text.trim();
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  if (TODAY_WORDS.test(t)) {
    return new Date(now);
  }

  if (TOMORROW_WORDS.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  if (DAYAFTER_WORDS.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }

  // DD-MM-YYYY or DD/MM/YYYY
  let m = DATE_DMY.exec(t);
  if (m) {
    const date = new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`);
    if (!isNaN(date.getTime()) && date >= now) return date;
    return null; // past date
  }

  // YYYY-MM-DD
  m = DATE_YMD.exec(t);
  if (m) {
    const date = new Date(`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`);
    if (!isNaN(date.getTime()) && date >= now) return date;
    return null;
  }

  return null;
}

/**
 * Try to extract a city name from a raw token.
 * First checks against the known-city list (longest-match),
 * then falls back to any word(s) that look like a proper noun (capitalised
 * or following a location keyword).
 *
 * @param {string} token  - raw text fragment
 * @returns {string|null}
 */
function extractCity(token) {
  const lower = token.trim().toLowerCase();
  if (!lower || lower.length < 2) return null;

  // Reject obvious noise words
  const NOISE = new Set([
    "a","an","the","i","my","me","we","us","our","from","to","at","in","on",
    "and","or","for","of","is","are","was","were","be","been","have","has",
    "want","need","book","reserve","any","some","trip","trips","seat","seats",
    "today","tomorrow","now","please","thanks","okay","ok","yes","no","hi",
    "hello","hey","going","travel","travelling","traveling","journey","ride",
    "ticket","tickets","passenger","passengers","person","people",
  ]);

  if (NOISE.has(lower)) return null;

  // Check known cities (multi-word first, then single)
  for (const city of KNOWN_CITIES) {
    if (lower === city || lower.startsWith(city) || lower.endsWith(city)) {
      return city.split(" ").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
    }
  }

  // Fallback: treat as city if ≥ 3 chars and not a number
  if (lower.length >= 3 && !/^\d+$/.test(lower)) {
    return token.trim().split(" ")
      .map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }

  return null;
}

/**
 * Parse a free-text message and return structured intent data.
 *
 * @param {string} rawText
 * @returns {{
 *   intent: "BOOK"|"CHECK"|"CANCEL"|"MENU"|"UNKNOWN",
 *   from:   string|null,
 *   to:     string|null,
 *   date:   Date|null,
 *   seats:  number|null,
 *   ref:    string|null,    // for CHECK intent
 * }}
 */
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

  /* ── Detect intent ──────────────────────────────────────────────────────── */
  if (MENU_WORDS.test(lower))   { result.intent = "MENU";   return result; }
  if (CANCEL_WORDS.test(lower)) { result.intent = "CANCEL"; return result; }

  // Reference code check (GT-XXXXXX)
  const refMatch = /\b(GT-[A-Z0-9]{5,8})\b/i.exec(text);
  if (refMatch) {
    result.intent = "CHECK";
    result.ref    = refMatch[1].toUpperCase();
    return result;
  }

  if (CHECK_WORDS.test(lower))  { result.intent = "CHECK";  }
  if (BOOK_WORDS.test(lower))   { result.intent = "BOOK";   }

  /* ── Extract date ───────────────────────────────────────────────────────── */
  result.date = resolveDate(lower);

  /* ── Extract seat count ─────────────────────────────────────────────────── */
  for (const pattern of SEAT_PATTERNS) {
    const m = pattern.exec(lower);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 10) { result.seats = n; break; }
    }
  }

  /* ── Extract route (origin → destination) ───────────────────────────────── */
  // Strategy 1: explicit "from X to Y" pattern
  const fromTo = /\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+on|\s+\d|\s+today|\s+tomorrow|$)/i.exec(text);
  if (fromTo) {
    const maybeFrom = extractCity(fromTo[1]);
    const maybeTo   = extractCity(fromTo[2]);
    if (maybeFrom) result.from = maybeFrom;
    if (maybeTo)   result.to   = maybeTo;
  }

  // Strategy 2: "X to Y" or "X - Y" anywhere in the text (if strategy 1 missed)
  if (!result.from || !result.to) {
    // Strip noise prefixes before trying
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

  // If we found a route, treat ambiguous intent as BOOK
  if (result.intent === "UNKNOWN" && (result.from || result.to)) {
    result.intent = "BOOK";
  }

  return result;
}

module.exports = { parseIntent, resolveDate };