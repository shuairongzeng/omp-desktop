/* electron/backend/widgets/redact.js — Node port of
   `src-tauri/src/widgets/redact.rs`.

   Best-effort redaction of credential-shaped text that a plugin printed and
   the rail would show: the tail of a failed run and the preview of a
   non-JSON stdout (`run.rs`). A CLI's diagnostics (`gh`, `glab`, `curl -v`)
   can echo an `Authorization` header, a token, or a URL with a password.

   Keys are the shared `REDACTED_KEYS` (agent.js's JSON list, the same one
   `redaction.rs` exports) plus a few free-text spellings, matched with the
   same normalized suffix comparison. Recognised shapes:

   - `key=value` / `key:value` / `"key":"value"` anywhere inside a word, so
     compact JSON, query strings and connection strings are covered;
   - `key: value`, `key= value`, and for `REDACTED_KEYS` also `key = value`
     (the value is the next word); a quoted value is masked up to its closing
     quote, at most to the end of the line;
   - `Bearer x` anywhere, `token x` / `basic x` only after a credential key
     (`Authorization: token x`);
   - known token prefixes (`PREFIXES`) and URL userinfo
     (`https://user:pw@host`).

   A linear scanner, not a parser: unknown shapes pass through. The input
   string is returned unchanged (same value) when nothing matches; the output
   is built once, only when something is masked.

   The shared list/matcher is agent.js's (`isCredentialKey`), not a second
   copy of it. agent.js keeps `normalizedKeyEndsWith` private, so the free-text
   spellings use `normalizedKeyEndsWith` below — the same algorithm, parity
   with `agent.isCredentialKey` is asserted in the port tests. */

'use strict';

const agent = require('../agent.js');

const {
  REDACTED_KEYS,
  REDACTED_PLACEHOLDER,
  isCredentialKey,
  sanitizeFrame,
  sanitizeLine,
} = agent;

// ── the widgets delta (`widgets/redact.rs`) ─────────────────────────────────

/**
 * Free-text key spellings on top of `REDACTED_KEYS`. Only in the tight forms
 * (`token=x`, `token: x`): a bare `token = …` is usually source code in a
 * traceback, not a secret.
 */
const FREE_TEXT_KEYS = ['token', 'passwd', 'cookie'];

/** Token prefixes that identify a credential on their own. */
const PREFIXES = [
  'sk-',
  'ghp_',
  'gho_',
  'ghs_',
  'ghu_',
  'ghr_',
  'github_pat_',
  'glpat-',
  'glcbt-',
  'glrt-',
  'xoxa-',
  'xoxb-',
  'xoxp-',
  'AKIA',
];
const PREFIX_MIN_BODY = 8;

/** Bytes that end a key: a new key starts after them. */
const KEY_BOUNDARY = Buffer.from(',;&?{}[]()<>|', 'latin1');
/** Bytes that end an unquoted value inside a word. */
const VALUE_END = Buffer.from(',;&)]}>"\'', 'latin1');

const NOTHING = 'nothing';
/** The previous word was a strong credential key without separator (`password`). */
const SEPARATOR = 'separator';
/** The next word is a credential value, unless it is an auth scheme. */
const VALUE = 'value';
/** The next word is the credential after an auth scheme. */
const SCHEME_VALUE = 'schemeValue';

const AUTH_SCHEMES = ['bearer', 'basic', 'token'];
const PLACEHOLDER_BYTES = Buffer.from(REDACTED_PLACEHOLDER, 'utf8');
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;
const SLASH = 0x2f;
const QUESTION = 0x3f;
const HASH = 0x23;
const AT = 0x40;
const EQUALS = 0x3d;
const COLON = 0x3a;

// ── shared-match helpers ───────────────────────────────────────────────────

/**
 * `redaction::normalized_key_ends_with` — whether `key`'s normalized form
 * (ASCII-lowercased, `_`/`-` removed) ends with `suffix`. agent.js keeps its
 * copy private; this is the same right-to-left byte comparison.
 */
function normalizedKeyEndsWith(key, suffix) {
  let j = key.length - 1;
  for (let i = suffix.length - 1; i >= 0; i -= 1) {
    while (j >= 0 && (key[j] === '_' || key[j] === '-')) j -= 1;
    if (j < 0) return false;
    if (key[j].toLowerCase() !== suffix[i]) return false;
    j -= 1;
  }
  return true;
}

/** `widgets::redact::is_key`: a shared credential key or a free-text spelling. */
function isKey(key) {
  return isCredentialKey(key) || FREE_TEXT_KEYS.some((free) => normalizedKeyEndsWith(key, free));
}

// ── byte helpers ───────────────────────────────────────────────────────────

function isAsciiWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d;
}

/** `[A-Za-z0-9_-]` (`is_token_byte`). */
function isTokenByte(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x2d
  );
}

/** `trim_matches(['"', '\''])`. */
function trimQuotes(text) {
  let start = 0;
  let end = text.length;
  while (start < end && (text[start] === '"' || text[start] === "'")) start += 1;
  while (end > start && (text[end - 1] === '"' || text[end - 1] === "'")) end -= 1;
  return text.slice(start, end);
}

function isOneOf(word, names) {
  const lower = word.toLowerCase();
  return names.some((name) => lower === name);
}

/** First `q` in `bytes[from..end]` not escaped by a backslash (`find_quote`). */
function findQuote(bytes, from, end, q) {
  for (let i = from; i < end; i += 1) {
    if (bytes[i] === q && (i === 0 || bytes[i - 1] !== BACKSLASH)) return i;
  }
  return null;
}

/** Index of `://` at or after `from`, or -1. */
function findSchemeSeparator(bytes, from, end) {
  for (let i = from; i + 2 < end; i += 1) {
    if (bytes[i] === COLON && bytes[i + 1] === SLASH && bytes[i + 2] === SLASH) return i;
  }
  return -1;
}

// ── the scanner ────────────────────────────────────────────────────────────

class Scanner {
  constructor(text) {
    this.text = text;
    this.bytes = Buffer.from(text, 'utf8');
    /** Byte ranges to replace, each on char boundaries. Unordered. */
    this.masks = [];
    this.expect = NOTHING;
    /** Open quote of a value that spans words. */
    this.quote = null;
  }

  /** `text[start..end]` as a string (both offsets are char boundaries). */
  slice(start, end) {
    return this.bytes.toString('utf8', start, end);
  }

  mask(from, to) {
    if (from < to) this.masks.push([from, to]);
  }

  word(start, end) {
    this.prefixedTokens(start, end);
    this.userinfo(start, end);
    let cursor;
    if (this.quote !== null) {
      const q = this.quote;
      const close = findQuote(this.bytes, start, end, q);
      if (close === null) {
        // An unclosed quote never masks past its line.
        this.mask(start, end);
        return;
      }
      this.mask(start, close);
      this.quote = null;
      cursor = close + 1;
    } else {
      const expected = this.expect;
      this.expect = NOTHING;
      const word = this.slice(start, end);
      if (expected === VALUE && isOneOf(word, AUTH_SCHEMES)) {
        this.expect = SCHEME_VALUE;
        return;
      }
      if (expected === VALUE || expected === SCHEME_VALUE) {
        const next = this.value(start, end);
        if (this.quote !== null) return;
        cursor = next;
      } else if (expected === SEPARATOR && (word === '=' || word === ':')) {
        this.expect = VALUE;
        return;
      } else {
        if (word.toLowerCase() === 'bearer') {
          this.expect = SCHEME_VALUE;
          return;
        }
        if (!word.includes('=') && !word.includes(':') && isCredentialKey(trimQuotes(word))) {
          this.expect = SEPARATOR;
          return;
        }
        cursor = start;
      }
    }
    this.pairs(cursor, end);
  }

  /**
   * Mask the value starting at `v` (non-empty, before `end`) and return where
   * scanning continues. A quoted value runs to its closing quote; if that is
   * not in this word, the quote stays open for the next words.
   */
  value(v, end) {
    const bytes = this.bytes;
    const q = bytes[v];
    if (q === DOUBLE_QUOTE || q === SINGLE_QUOTE) {
      const close = findQuote(bytes, v + 1, end, q);
      if (close !== null) {
        this.mask(v + 1, close);
        return close + 1;
      }
      this.mask(v + 1, end);
      this.quote = q;
      return end;
    }
    let stop = end;
    for (let i = v; i < end; i += 1) {
      if (VALUE_END.includes(bytes[i])) {
        stop = i;
        break;
      }
    }
    this.mask(v, stop);
    return stop;
  }

  /** `key=value` / `key:value` pairs inside `[from, end)`. */
  pairs(from, end) {
    const bytes = this.bytes;
    let keyStart = from;
    let i = from;
    while (i < end) {
      const byte = bytes[i];
      if (byte === EQUALS || byte === COLON) {
        const v = i + 1;
        const url =
          byte === COLON && end - v >= 2 && bytes[v] === SLASH && bytes[v + 1] === SLASH;
        if (!url && isKey(trimQuotes(this.slice(keyStart, i)))) {
          if (v === end) {
            this.expect = VALUE;
            return;
          }
          if (isOneOf(this.slice(v, end), AUTH_SCHEMES)) {
            this.expect = SCHEME_VALUE;
            return;
          }
          i = this.value(v, end);
          if (this.quote !== null) return;
          keyStart = i;
          continue;
        }
        keyStart = v;
      } else if (KEY_BOUNDARY.includes(byte)) {
        keyStart = i + 1;
      }
      i += 1;
    }
  }

  /** Runs of `[A-Za-z0-9_-]` that start with a known token prefix. */
  prefixedTokens(start, end) {
    const bytes = this.bytes;
    let i = start;
    while (i < end) {
      if (!isTokenByte(bytes[i])) {
        i += 1;
        continue;
      }
      const runStart = i;
      while (i < end && isTokenByte(bytes[i])) i += 1;
      const run = this.slice(runStart, i);
      if (PREFIXES.some((prefix) => run.startsWith(prefix) && run.length >= prefix.length + PREFIX_MIN_BODY)) {
        this.mask(runStart, i);
      }
    }
  }

  /**
   * `scheme://userinfo@host` → the userinfo. The authority runs to the first
   * `/`, `?` or `#`, and the userinfo to its *last* `@`.
   */
  userinfo(start, end) {
    const bytes = this.bytes;
    let search = start;
    for (;;) {
      const found = findSchemeSeparator(bytes, search, end);
      if (found < 0) return;
      const infoStart = found + 3;
      let authority = end - infoStart;
      for (let i = infoStart; i < end; i += 1) {
        if (bytes[i] === SLASH || bytes[i] === QUESTION || bytes[i] === HASH) {
          authority = i - infoStart;
          break;
        }
      }
      let at = -1;
      for (let i = infoStart + authority - 1; i >= infoStart; i -= 1) {
        if (bytes[i] === AT) {
          at = i - infoStart;
          break;
        }
      }
      if (at >= 0) this.mask(infoStart, infoStart + at);
      // Not past the authority: its end can be the `/` of the next URL's
      // `://` in the same word.
      search = infoStart;
    }
  }

  finish() {
    if (this.masks.length === 0) return this.text;
    const masks = this.masks.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const parts = [];
    let done = 0;
    for (const [from, to] of masks) {
      if (to <= done) continue; // inside the previous mask
      if (from >= done) {
        parts.push(this.bytes.subarray(done, from));
        parts.push(PLACEHOLDER_BYTES);
      } // else overlapping: extend the placeholder already written
      done = to;
    }
    parts.push(this.bytes.subarray(done));
    return Buffer.concat(parts).toString('utf8');
  }
}

/**
 * Mask credential-shaped text (`widgets::redact::redact_secrets`). Returns
 * `text` itself when nothing matches.
 */
function redactSecrets(text) {
  const scanner = new Scanner(String(text));
  const bytes = scanner.bytes;
  let i = 0;
  while (i < bytes.length) {
    const gap = i;
    while (i < bytes.length && isAsciiWhitespace(bytes[i])) i += 1;
    let newline = false;
    for (let k = gap; k < i; k += 1) {
      if (bytes[k] === NEWLINE) {
        newline = true;
        break;
      }
    }
    if (newline) scanner.quote = null;
    const start = i;
    while (i < bytes.length && !isAsciiWhitespace(bytes[i])) i += 1;
    if (start < i) scanner.word(start, i);
  }
  return scanner.finish();
}

module.exports = {
  // shared list and matcher (agent.js / redaction.rs)
  REDACTED_KEYS,
  REDACTED_PLACEHOLDER,
  isCredentialKey,
  normalizedKeyEndsWith,
  sanitizeFrame,
  sanitizeLine,
  // the widgets delta
  FREE_TEXT_KEYS,
  PREFIXES,
  PREFIX_MIN_BODY,
  KEY_BOUNDARY,
  VALUE_END,
  isKey,
  redactSecrets,
};