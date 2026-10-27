/* electron/backend/browser-annotate.js — Node port of
   `src-tauri/src/browser/annotate/` (overlay install, pick gating, capture).

   Annotate mode: the overlay script (`overlay.js` in Rust, embedded verbatim
   below) runs in the isolated world "omp-annotate" of every page session the
   view attaches to. Chromium creates that world as an execution context
   named WORLD; the view turns the overlay on and off by evaluating in those
   contexts, and a context created later (a new document) is switched on by
   this module's event handler while annotate is on. The binding is exposed
   in that world only, so a page script cannot forge a pick; and only a click
   the panel sent makes one, not the agent's: a pick counts only after the
   panel released a mouse button (View#input of `Input.dispatchMouseEvent`
   `mouseReleased`, wired through View's "panelRelease" event or
   `notePanelRelease()`), within PICK_AFTER_RELEASE_MS.

   Parity, Rust → here:
   - install: `Runtime.enable`, `Runtime.addBinding { name: "__ompAnnotate",
     executionContextName: "omp-annotate" }`, then
     `Page.addScriptToEvaluateOnNewDocument { source, worldName,
     runImmediately: true }` — same order, same params. Idempotent per
     installed Annotate.
   - pick: `pick.rs` `parse` bounds (256 KiB payload, 20 000 HTML chars, 500
     text, 8192 url/selector), requires `rect` and `docRect` sane, an
     "element" pick needs selector and tag (area fields nulled), an "area"
     narrower/taller than 1 CSS pixel is no pick. Lone surrogates are
     refused, as serde refused them in Rust: the embedded overlay runs
     `toWellFormed()` for the same reason.
   - capture: `capture.rs` — hide the overlay only visually (annotate stays
     on), read the viewport in the overlay's world (`__ompAnnotateHide`),
     cut the picked document rect to that viewport, scale the longest side to
     MAX_EDGE_PX device pixels, then `Page.captureScreenshot` with that clip;
     the overlay is shown again whatever happens.
   - The Rust overlay file is embedded below as `OVERLAY` (needed for
     `Page.addScriptToEvaluateOnNewDocument`); the only change is backticks
     inside its comments, rewritten as apostrophes so it can sit in a
     String.raw template. The script's behavior is unchanged.

   Deliberate deviations: Rust's Core owned the client, the annotate state and
   the "released within" clock; here one `Annotate` owns the overlay state of
   one target and reads the release clock from an injected View (or from
   `notePanelRelease`). Rust's `release_overlay` is `close()`. */

'use strict';

const { EventEmitter } = require('node:events');

const WORLD = 'omp-annotate';
const BINDING = '__ompAnnotate';
/** How long after the panel released the mouse a pick counts as the user's. */
const PICK_AFTER_RELEASE_MS = 2000;
/** What a binding call may carry, and the caps of its fields. */
const MAX_PAYLOAD = 256 * 1024;
const MAX_HTML = 20000;
const MAX_TEXT = 500;
const MAX_FIELD = 8192;
/** Longest side of a captured image in device pixels (`MAX_EDGE_PX`). */
const MAX_EDGE_PX = 2000;
/** Hide (counted) and show the overlay; both read the viewport. */
const HIDE = 'window.__ompAnnotateHide(true)';
const SHOW = 'window.__ompAnnotateHide(false)';

const EVENTS = [
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Runtime.executionContextsCleared',
  'Runtime.bindingCalled',
];

/** `window.__ompAnnotateSet(<on>)` in a context of the overlay's world. */
function setParams(on, contextId) {
  return {
    expression: `window.__ompAnnotateSet && window.__ompAnnotateSet(${Boolean(on)})`,
    contextId,
  };
}

/** Finite, non-negative extent, coordinates within a sane range. */
function sane(rect) {
  if (!rect || typeof rect !== 'object') return false;
  const values = [rect.x, rect.y, rect.w, rect.h];
  return (
    values.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7) &&
    rect.w >= 0 &&
    rect.h >= 0
  );
}

function rectOf(rect) {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/** Keep at most `max` Unicode scalar values of `text`. */
function capChars(text, max) {
  if (typeof text !== 'string') return text;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** Whether `text` has no lone surrogate (serde refused such a pick). */
function wellFormed(text) {
  if (typeof text !== 'string') return true;
  if (typeof text.isWellFormed === 'function') return text.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/**
 * A pick from the overlay's report, bounded; null for anything the overlay
 * would not send (`pick.rs` `parse`).
 */
function parsePick(report) {
  let payload = report;
  if (payload && typeof payload === 'object') {
    try {
      payload = JSON.stringify(payload);
    } catch {
      return null;
    }
  }
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD) return null;
  let pick;
  try {
    pick = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!pick || typeof pick !== 'object') return null;
  // The capture is made of `docRect`: a pick without one is no pick.
  if (!sane(pick.rect) || !sane(pick.docRect)) return null;
  for (const field of [pick.url, pick.selector, pick.tag, pick.html, pick.text]) {
    if (typeof field === 'string' && !wellFormed(field)) return null;
  }
  const url = capChars(typeof pick.url === 'string' ? pick.url : '', MAX_FIELD);
  if (pick.kind === 'element') {
    if (typeof pick.selector !== 'string' || typeof pick.tag !== 'string') return null;
    const selector = capChars(pick.selector, MAX_FIELD);
    const tag = capChars(pick.tag, MAX_FIELD);
    const html = typeof pick.html === 'string' ? capChars(pick.html, MAX_HTML) : null;
    const text = typeof pick.text === 'string' ? capChars(pick.text, MAX_TEXT) : null;
    return { kind: 'element', selector, tag, rect: rectOf(pick.rect), docRect: rectOf(pick.docRect), html, text, url };
  }
  if (pick.kind === 'area') {
    // The overlay reports a thinner drag as an element pick.
    if (pick.rect.w < 1 || pick.rect.h < 1) return null;
    return { kind: 'area', selector: null, tag: null, rect: rectOf(pick.rect), docRect: rectOf(pick.docRect), html: null, text: null, url };
  }
  return null;
}

/**
 * The gating rule: a pick counts only right after the panel released a mouse
 * button (`releasedAt`, at most `within` ago), then it is parsed and bounded.
 */
function pick(report, gate = {}) {
  const { releasedAt = null, now = Date.now(), within = PICK_AFTER_RELEASE_MS } = gate;
  if (releasedAt == null || now < releasedAt || now - releasedAt > within) return null;
  return parsePick(report);
}

/** The visible part of the document, in document CSS pixels, and its DPR. */
function viewportOf(value) {
  if (!value || typeof value !== 'object') return null;
  const number = (key) => (typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] : null);
  const area = { x: number('x'), y: number('y'), w: number('w'), h: number('h') };
  if (Object.values(area).some((field) => field == null)) return null;
  const dpr = number('dpr');
  if (dpr == null || dpr <= 0) return null;
  return sane(area) ? { area, dpr } : null;
}

/**
 * `Page.captureScreenshot`'s clip: the document rect `doc` cut to the
 * viewport, scaled so that its longest side stays within MAX_EDGE_PX.
 */
function clip(doc, viewport) {
  if (!sane(doc)) throw new Error('invalid capture area');
  const v = viewport.area;
  const left = Math.max(doc.x, v.x);
  const top = Math.max(doc.y, v.y);
  const width = Math.min(doc.x + doc.w, v.x + v.w) - left;
  const height = Math.min(doc.y + doc.h, v.y + v.h) - top;
  if (width < 1 || height < 1) throw new Error('the picked area is out of view');
  const scale = Math.min(MAX_EDGE_PX / (Math.max(width, height) * viewport.dpr), 1);
  return { x: left, y: top, width, height, scale };
}

function isClipShape(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
}

/**
 * The annotate state of one page target: overlay installation, the contexts
 * of its world, picks, and captures. One per view and page session.
 */
class Annotate extends EventEmitter {
  constructor({ client = null, targetId = null, view = null, within = PICK_AFTER_RELEASE_MS, now = Date.now } = {}) {
    super();
    this.client = client;
    this.targetId = targetId;
    this.sessionId = null;
    this.view = view;
    this.within = within;
    this.now = now;
    this.contexts = [];
    this.on = false;
    this.picked = null;
    this.lastPanelRelease = null;
    this.installed = false;
    this.closed = false;
    this._listening = false;
    if (view && typeof view.on === 'function') {
      view.on('panelRelease', (at) => this.notePanelRelease(at));
    }
  }

  /** Install the overlay on this target; idempotent. */
  async install() {
    if (this.installed) return this;
    if (!this.client) throw new Error('annotate overlay: cdp not connected');
    if (this.sessionId == null) this.sessionId = await this.client.sessionFor(this.targetId);
    this._listen();
    // In order on the session: `Runtime.enable` first (it reports the world
    // `runImmediately` makes), then the binding the script calls.
    this._notify('Runtime.enable', {});
    this._notify('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    await this._call('Page.addScriptToEvaluateOnNewDocument', {
      source: OVERLAY,
      worldName: WORLD,
      runImmediately: true,
    });
    this.installed = true;
    return this;
  }

  _listen() {
    if (this._listening || !this.client) return;
    this._listening = true;
    this.client.on('event', (event) => this.handleEvent(event ?? {}));
  }

  _notify(method, params) {
    if (!this.client || this.sessionId == null) return;
    this.client.send(method, params, { sessionId: this.sessionId }).catch(() => {});
  }

  _call(method, params) {
    if (!this.client || this.sessionId == null) throw new Error('annotate overlay: cdp not connected');
    return this.client.send(method, params, { sessionId: this.sessionId });
  }

  /** The reader side: this target's overlay contexts and its picks. */
  handleEvent({ method, params, sessionId } = {}) {
    if (this.closed || this.sessionId == null || sessionId !== this.sessionId) return;
    if (method === 'Runtime.executionContextCreated') {
      const context = params?.context ?? {};
      if (context.name !== WORLD || !Number.isInteger(context.id)) return;
      if (!this.contexts.includes(context.id)) this.contexts.push(context.id);
      // Notifications stay ordered: a release or toggle cannot be followed by a stale enable.
      if (this.on) this._notify('Runtime.evaluate', setParams(true, context.id));
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      const id = params?.executionContextId;
      this.contexts = this.contexts.filter((context) => context !== id);
      if (this.picked?.contextId === id) this.picked = null;
      return;
    }
    if (method === 'Runtime.executionContextsCleared') {
      this.contexts = [];
      this.picked = null;
      return;
    }
    if (method === 'Runtime.bindingCalled') {
      if (params?.name !== BINDING) return;
      const contextId = params.executionContextId;
      if (!this.contexts.includes(contextId)) return;
      const parsed = this.pick(params.payload);
      if (!parsed) return;
      this.picked = { sessionId: this.sessionId, contextId, docRect: parsed.docRect };
      this.emit('pick', parsed);
    }
  }

  /** Turn annotate mode on or off for this target's overlay, now and later. */
  async setOn(on) {
    if (this.closed) throw new Error('view closed');
    if (on) await this.install();
    this.on = Boolean(on);
    for (const contextId of this.contexts) this._notify('Runtime.evaluate', setParams(this.on, contextId));
    const last = this.contexts[this.contexts.length - 1];
    // One round trip after them, so a fresh frame shows the change.
    if (last != null) await this._call('Runtime.evaluate', { expression: '0', contextId: last }).catch(() => {});
    return this;
  }

  /** The panel released a mouse button on the page at `at`. */
  notePanelRelease(at = this.now()) {
    this.lastPanelRelease = at;
    return this;
  }

  /** Whether the panel released a mouse button in the last `within` ms. */
  panelReleasedWithin(within = this.within, at = this.now()) {
    return this.lastPanelRelease != null && at - this.lastPanelRelease <= within;
  }

  /**
   * A reported pick: counted only after a panel release (see `pick`), then
   * bounded. The newest report replaces nothing: every pick it accepts is
   * emitted and becomes the capture context.
   */
  pick(report, gate = {}) {
    return pick(report, {
      within: this.within,
      now: gate.now ?? this.now(),
      releasedAt: gate.releasedAt ?? this.lastPanelRelease,
    });
  }

  /**
   * A PNG of a pick, from the document the last pick came from: `clip` is a
   * `Page.captureScreenshot` clip, or a document CSS rect to cut to the
   * viewport (Rust's `Core::capture`). The overlay is hidden for the shot,
   * only visually.
   */
  async capture(clipOrRect = null) {
    if (!this.client || this.sessionId == null) throw new Error('annotate overlay: cdp not connected');
    if (this.picked == null) throw new Error('the page changed since the pick');
    const { contextId } = this.picked;
    const evaluate = (expression) =>
      this._call('Runtime.evaluate', { expression, contextId, returnByValue: true });
    // A gone context fails here. A hide that timed out may still run later:
    // the show below follows it on the session either way (the overlay clamps
    // its counter), so it never stays hidden.
    let hidden;
    try {
      hidden = await evaluate(HIDE);
    } catch {
      throw new Error('the page changed since the pick');
    }
    let shot;
    try {
      const viewport = viewportOf(hidden?.result?.value);
      if (!viewport) throw new Error("could not read the page's viewport");
      const computed = isClipShape(clipOrRect)
        ? clipOrRect
        : clip(clipOrRect ?? this.picked.docRect ?? viewport.area, viewport);
      shot = await this._call('Page.captureScreenshot', {
        format: 'png',
        clip: computed,
        captureBeyondViewport: false,
      });
    } finally {
      // Whatever the outcome. A failed show means the document is gone (its
      // successor has its own overlay): the shot stands.
      await evaluate(SHOW).catch(() => {});
    }
    const data = shot?.data;
    if (typeof data !== 'string') throw new Error('capture returned no image');
    return { data, mimeType: 'image/png' };
  }

  /** Forget this target's overlay (the session is about to be detached). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.on = false;
    this.contexts = [];
    this.picked = null;
    this.emit('close');
  }
}

/** Install the overlay on `targetId` and return its `Annotate`. */
async function install(client, targetId, options = {}) {
  const annotate = new Annotate({ client, targetId, ...options });
  await annotate.install();
  return annotate;
}

/**
 * The overlay script, embedded from `src-tauri/src/browser/annotate/
 * overlay.js` (comments only changed backticks to apostrophes).
 */
const OVERLAY = String.raw`// The annotate overlay, run in the isolated world "omp-annotate" of every page
// of the browser panel (see 'annotate/mod.rs'). It reports through the binding
// '__ompAnnotate', which Chromium exposes in that world only: the page's own
// scripts can neither call it nor see this file's state.
//
// Everything is drawn with CSSOM ('element.style.x = ...') and 'textContent',
// never a <style> element, a 'style="..."' attribute or markup strings, so a
// page whose CSP forbids inline styles (or demands Trusted Types) cannot block
// it.
(() => {
  'use strict';
  if (window.__ompAnnotateSet) return;

  // Everything a click or a hover would make the page do. Not 'wheel' or keys:
  // the page keeps scrolling, and Esc is the panel's business.
  const SWALLOWED = [
    'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
    'pointerenter', 'pointerleave',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
    'mouseenter', 'mouseleave',
    'click', 'dblclick', 'auxclick', 'contextmenu',
  ];

  let on = false;

  // Keep a user's event from the page; whether it was one. Synthetic events
  // ('el.click()' from the page's scripts or the agent) are not the user's:
  // they reach the page untouched.
  const swallow = (e) => {
    if (!on || !e.isTrusted) return false;
    // Cancelling a pointerdown would also suppress the mouse events that
    // follow it, which this overlay is driven by: only stop those.
    if (!e.type.startsWith('pointer')) e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return true;
  };

  // A frame inside the page (same process: Chromium runs this world in each)
  // only swallows: its picks would be in the frame's own coordinates, so
  // there is no overlay and no report there. Rust sends the flag to every
  // context of this world, so frames follow it like the top document.
  if (window.top !== window) {
    for (const type of SWALLOWED) window.addEventListener(type, swallow, true);
    window.__ompAnnotateSet = (value) => {
      on = Boolean(value);
    };
    return;
  }

  const DRAG_PX = 4;
  const MAX_HTML = 20000;
  const MAX_TEXT = 500;
  const MAX_FIELD = 8192;
  const MAX_ANCESTORS = 6;
  const MAX_CLASSES = 2;
  const LAYER = '2147483647';

  let hidden = 0; // captures in progress, each hiding the overlay
  let host = null;
  let hoverBox = null;
  let hoverLabel = null;
  let dragBox = null;
  let start = null; // { x, y } of a pressed left button
  let dragging = false;

  const box = (parent, look) => {
    const el = document.createElement('div');
    Object.assign(el.style, { position: 'fixed', display: 'none', boxSizing: 'border-box' }, look);
    parent.appendChild(el);
    return el;
  };

  // Needs no document element: the boxes exist from the first event on.
  const build = () => {
    host = document.createElement('omp-annotate-overlay');
    Object.assign(host.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0', left: '0',
      pointerEvents: 'none', zIndex: LAYER,
    });
    const shadow = host.attachShadow({ mode: 'closed' });
    hoverBox = box(shadow, {
      border: '2px solid #2f81f7', background: 'rgba(47, 129, 247, 0.15)',
    });
    hoverLabel = document.createElement('div');
    Object.assign(hoverLabel.style, {
      position: 'absolute', left: '-2px', bottom: '100%', maxWidth: '60vw',
      overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      font: '11px/16px monospace', color: '#fff', background: '#2f81f7', padding: '0 4px',
    });
    hoverBox.appendChild(hoverLabel);
    dragBox = box(shadow, {
      border: '2px dashed #2f81f7', background: 'rgba(47, 129, 247, 0.1)',
    });
  };

  const show = () => {
    if (host) host.style.visibility = hidden > 0 ? 'hidden' : '';
  };

  const mount = () => {
    if (!host) build();
    if (!on || host.isConnected) return;
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', mount, { once: true });
      return;
    }
    document.documentElement.appendChild(host);
  };

  const place = (el, x, y, w, h) => {
    Object.assign(el.style, {
      display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px',
    });
  };

  const clear = () => {
    start = null;
    dragging = false;
    if (hoverBox) hoverBox.style.display = 'none';
    if (dragBox) dragBox.style.display = 'none';
  };

  const cls = (el) => Array.from(el.classList).slice(0, MAX_CLASSES)
    .map((c) => '.' + CSS.escape(c)).join('');

  // At most 'n' UTF-16 units, never ending in half a surrogate pair, and no
  // lone surrogate anywhere: 'JSON.stringify' would escape one as '\udXXX',
  // which the Rust side refuses, dropping the whole pick.
  const trim = (s, n) => {
    let cut = s;
    if (s.length > n) {
      cut = s.slice(0, n);
      const last = cut.charCodeAt(cut.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    }
    return typeof cut.toWellFormed === 'function' ? cut.toWellFormed() : cut;
  };

  // 'localName' keeps the case of SVG names ('foreignObject'), which their
  // type selectors need.
  const segment = (el) => {
    let seg = CSS.escape(el.localName) + cls(el);
    const parent = el.parentElement;
    if (parent) {
      // ':nth-of-type(n)' only when the tag+class still matches a sibling:
      // 'button.save' next to 'button.cancel' already picks it out.
      const siblings = Array.from(parent.children);
      if (siblings.some((c) => c !== el && c.tagName === el.tagName && c.matches(seg))) {
        const byTag = siblings.filter((c) => c.tagName === el.tagName);
        seg += ':nth-of-type(' + (byTag.indexOf(el) + 1) + ')';
      }
    }
    return seg;
  };

  const unique = (selector, el) => {
    if (selector.length > MAX_FIELD) return false;
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch (_) {
      return false;
    }
  };

  // '#id', else '[data-testid="..."]', else the shortest chain of at most six
  // 'tag.class:nth-of-type(n)' segments (nearest ancestors first) that finds
  // only this element.
  const selectorOf = (el) => {
    if (el.id) {
      const byId = '#' + CSS.escape(el.id);
      if (unique(byId, el)) return byId;
    }
    const testId = el.getAttribute('data-testid');
    if (testId !== null) {
      const byTestId = '[data-testid="' + testId.replace(/["\\]/g, '\\$&') + '"]';
      if (unique(byTestId, el)) return byTestId;
    }
    const chain = [];
    let node = el;
    for (let i = 0; i < MAX_ANCESTORS && node && node.nodeType === 1; i += 1) {
      chain.unshift(segment(node));
      const selector = chain.join(' > ');
      if (unique(selector, el) || node === document.documentElement) return selector;
      node = node.parentElement;
    }
    return chain.join(' > ');
  };

  const elementAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host ? el : null;
  };

  const documentRect = (rect) => ({
    ...rect, x: rect.x + window.scrollX, y: rect.y + window.scrollY,
  });

  const report = (payload) => {
    try {
      window.__ompAnnotate(JSON.stringify({ ...payload, url: trim(location.href, MAX_FIELD) }));
    } catch (_) {
      // No binding (the panel detached): nothing to tell.
    }
  };

  const reportElement = (el) => {
    const r = el.getBoundingClientRect();
    const rect = { x: r.x, y: r.y, w: r.width, h: r.height };
    const text = el.innerText === undefined ? el.textContent : el.innerText;
    report({
      kind: 'element',
      selector: trim(selectorOf(el), MAX_FIELD),
      tag: trim(el.localName, MAX_FIELD),
      rect,
      docRect: documentRect(rect),
      html: trim(el.outerHTML, MAX_HTML),
      text: trim(text || '', MAX_TEXT),
    });
  };

  const reportArea = (rect) => {
    report({
      kind: 'area',
      selector: null, tag: null, html: null, text: null,
      rect,
      docRect: documentRect(rect),
    });
  };

  const hover = (x, y) => {
    const el = elementAt(x, y);
    if (!el) {
      hoverBox.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    place(hoverBox, r.left, r.top, r.width, r.height);
    hoverLabel.textContent = segment(el);
  };

  const onEvent = (e) => {
    if (!swallow(e)) return;
    if (e.button > 0 || !e.type.startsWith('mouse')) return;
    const point = { x: e.clientX, y: e.clientY };
    if (e.type === 'mousedown') {
      start = point;
      dragging = false;
    } else if (e.type === 'mousemove') {
      if (start && !dragging && Math.hypot(point.x - start.x, point.y - start.y) > DRAG_PX) {
        dragging = true;
        hoverBox.style.display = 'none';
      }
      if (dragging) {
        place(dragBox, Math.min(start.x, point.x), Math.min(start.y, point.y),
          Math.abs(point.x - start.x), Math.abs(point.y - start.y));
      } else if (!start) {
        hover(point.x, point.y);
      }
    } else if (e.type === 'mouseup' && start) {
      const from = start;
      const wasDragging = dragging;
      clear();
      const area = {
        x: Math.min(from.x, point.x), y: Math.min(from.y, point.y),
        w: Math.abs(from.x - point.x), h: Math.abs(from.y - point.y),
      };
      // A drag thinner than a pixel has no area to capture: the element
      // under the release is what was meant.
      if (wasDragging && area.w >= 1 && area.h >= 1) {
        reportArea(area);
      } else {
        const el = elementAt(point.x, point.y);
        if (el) reportElement(el);
      }
    }
  };

  // Registered at once, ahead of the page's own scripts where this runs at
  // document start; 'on' decides whether they do anything.
  for (const type of SWALLOWED) window.addEventListener(type, onEvent, true);

  window.__ompAnnotateSet = (value) => {
    on = Boolean(value);
    if (on) {
      hidden = 0;
      mount();
      show();
    } else {
      clear();
      if (host) host.remove();
    }
  };

  // Hide ('true') or show again ('false') for a capture, only visually: 'on'
  // stays, so clicks are still swallowed. Gives the viewport in document CSS
  // pixels, read here where the page cannot redefine 'scrollX'.
  window.__ompAnnotateHide = (hide) => {
    hidden = Math.max(0, hidden + (hide ? 1 : -1));
    show();
    return {
      x: window.scrollX, y: window.scrollY,
      w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
    };
  };
})();
`;

module.exports = {
  Annotate,
  install,
  pick,
  parsePick,
  clip,
  viewportOf,
  sane,
  setParams,
  OVERLAY,
  EVENTS,
  WORLD,
  BINDING,
  HIDE,
  SHOW,
  PICK_AFTER_RELEASE_MS,
  MAX_PAYLOAD,
  MAX_EDGE_PX,
};