/* ═════════════════════════════════════════════════════════════════════
   settings/controls.jsx — building blocks of the Settings page (#37):
   the row frame, its controls, theme cards, accent swatches and the
   section strip. Custom rows (settings/rows-*.jsx) build on the same
   frame and controls, so every row looks and behaves alike.

   Text from the schema is highlighted by splitting it into text nodes and
   <mark> elements; `backtick` segments of a description render as <code>.
   No HTML strings are ever injected.
   ═════════════════════════════════════════════════════════════════════ */

const { Icon: _ST_Icon } = window;

const _ST_escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Roving-tabindex arrows for a `role=radiogroup`: ←/→ (plus ↑/↓ for a
 *  vertical group) move between its `role=radio` buttons, wrapping; the
 *  focused one is also the checked one, per the ARIA radio pattern. Returns
 *  the group's onKeyDown. */
function _ST_radioKeyNav(e) {
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const radios = [...e.currentTarget.querySelectorAll('[role="radio"]')];
  if (!radios.length) return;
  e.preventDefault();
  const i = radios.indexOf(document.activeElement);
  const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
  const next = radios[(i + step + radios.length) % radios.length];
  next.focus();
  next.click();
}

/** The tabindex a `role=radio` button takes in the roving pattern: 0 for
 *  the checked one (or the first, when none is), -1 for the rest. */
function _ST_radioTabIndex(items, value, get) {
  const focusIdx = Math.max(0, items.findIndex(it => get(it) === value));
  return i => (i === focusIdx ? 0 : -1);
}

function SettingsMark({ text, query }) {
  const q = (query ?? "").trim();
  if (!q || !text) return text ?? null;
  // A capturing split puts the matches at the odd indices.
  const parts = String(text).split(new RegExp(`(${_ST_escapeRe(q)})`, "i"));
  return parts.map((p, i) => (i % 2 ? <mark className="st-mark" key={i}>{p}</mark> : p));
}

/** A schema description: `backtick` segments as <code>, all highlighted. */
function SettingsDesc({ text, query }) {
  return String(text ?? "").split("`").map((p, i) => (i % 2
    ? <code key={i}><SettingsMark text={p} query={query} /></code>
    : <React.Fragment key={i}><SettingsMark text={p} query={query} /></React.Fragment>));
}

/** One setting: label (+ changed dot and reset), description, control.
 *  `stack` puts `children` full-width under the label line, `aside` then
 *  sits at the end of that line. String label/desc are highlighted.
 *  `resettable`: off its default but not counted in the badges (a
 *  Rust-backed row): the reset shows without the changed dot. */
function SettingsRow({ label, desc, modified, resettable, onReset, stack, aside, className = "", crumb, query, children }) {
  // Flash the row once it is reset, as feedback for a click on a control
  // that vanishes with the change.
  const [flash, setFlash] = React.useState(false);
  const reset = () => { setFlash(true); onReset(); };
  const head = (
    <div className="st-rt">
      <div className="st-rl">
        {typeof label === "string" ? <SettingsMark text={label} query={query} /> : label}
        {modified && <span className="st-moddot" title="Changed from default" />}
        {(modified || resettable) && onReset && (
          <button type="button" className="st-reset" onClick={reset} title="Reset to default">↺ reset</button>
        )}
      </div>
      {desc != null && desc !== "" && (
        <div className="st-rd">
          {crumb && <span className="st-crumb">{crumb} · </span>}
          {typeof desc === "string" ? <SettingsDesc text={desc} query={query} /> : desc}
        </div>
      )}
    </div>
  );
  const cls = `st-row${stack ? " stack" : ""}${flash ? " flash" : ""}${className ? ` ${className}` : ""}`;
  return (
    <div className={cls} onAnimationEnd={() => setFlash(false)}>
      {stack ? <div className="st-rhead">{head}{aside}</div> : head}
      {children}
    </div>
  );
}

/** A switch. `className` adds to `st-tgl` (e.g. `st-tgl-pending busy`,
 *  rows-agent.jsx); `disabled` blocks the click while a write is in flight. */
function SettingsToggle({ value, onChange, label, className = "", disabled }) {
  return (
    <button type="button" className={`st-tgl${className ? ` ${className}` : ""}`} role="switch"
      aria-checked={!!value} aria-label={label} aria-disabled={disabled || undefined}
      disabled={disabled} onClick={() => onChange(!value)} />
  );
}

/** Segmented choice; `options` [{ value, label }]. Roving tabindex: the
 *  checked option is the tab stop, ←/→ move and pick within the group. */
function SettingsSeg({ value, options, onChange, label }) {
  const idx = _ST_radioTabIndex(options, value, o => o.value);
  return (
    <div className="st-seg" role="radiogroup" aria-label={label} onKeyDown={_ST_radioKeyNav}>
      {options.map((o, i) => (
        <button type="button" key={String(o.value)} role="radio" aria-checked={o.value === value}
          tabIndex={idx(i)} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Range input. Shows the value while dragging, commits on release (pointer,
 *  key or blur) so a drag is one change, not one per pixel. The shown value
 *  is `aria-valuetext` (unit included), and a double-click on it turns into
 *  a small input: Enter commits, Escape (or blur) cancels. */
function SettingsSlider({ value, min, max, step = 1, unit = "", onChange, label }) {
  const [draft, setDraft] = React.useState(null);
  const [edit, setEdit] = React.useState(null); // null | string
  const editRef = React.useRef(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft === null) return;
    if (draft !== value) onChange(draft);
    setDraft(null);
  };
  const finishEdit = ok => {
    if (ok) {
      const n = Number(edit);
      if (Number.isFinite(n)) onChange(window.OMP_SETTINGS.clamp({ type: "slider", min, max, step }, n));
    }
    setEdit(null);
  };
  React.useEffect(() => { if (edit !== null) editRef.current?.select(); }, [edit]);
  return (
    <div className="st-slider">
      <input type="range" min={min} max={max} step={step} value={shown} aria-label={label}
        aria-valuetext={`${shown}${unit}`}
        onChange={e => setDraft(Number(e.target.value))}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      {edit === null ? (
        <span className="st-val" title="double-click to type a value"
          onDoubleClick={() => setEdit(String(shown))}>{shown}{unit}</span>
      ) : (
        <input ref={editRef} className="st-val-input" type="text" inputMode="numeric" value={edit}
          aria-label={`${label} value`} data-st-esc=""
          onChange={e => setEdit(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); finishEdit(true); }
            else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
          }}
          onBlur={() => finishEdit(true)} />
      )}
    </div>
  );
}

function SettingsButton({ children, onClick, accent, disabled, title }) {
  return (
    <button type="button" className={`st-btn${accent ? " ac" : ""}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** Theme picker: each card carries `theme-<id>`, which scopes that theme's
 *  tokens (styles.css) to the card, so it previews itself. Roving tabindex:
 *  the checked card is the tab stop, ←/→ move and pick. */
const _ST_cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
function ThemeCards({ value, themes, onChange }) {
  const idx = _ST_radioTabIndex(themes, value, th => th.id);
  return (
    <div className="st-themes" role="radiogroup" aria-label="Theme" onKeyDown={_ST_radioKeyNav}>
      {themes.map((th, i) => (
        <button type="button" key={th.id} className={`st-th theme-${th.id}`} role="radio"
          aria-checked={value === th.id} tabIndex={idx(i)} onClick={() => onChange(th.id)}>
          <div className="st-pv">
            <div className="st-pv-s"><i className="a" /><i /><i /><i /></div>
            <div className="st-pv-c"><i className="me" /><i style={{ width: "80%" }} /><i className="cd" /><i style={{ width: "60%" }} /></div>
          </div>
          <div className="st-nm"><span className="st-radio" />{_ST_cap(th.id)}<small>{th.tone}</small></div>
        </button>
      ))}
    </div>
  );
}

/** Accent: the theme's own (pill) or one of the swatches. Roving tabindex:
 *  the picked one is the tab stop, ←/→ move and pick. */
const _ST_COLOR_NAMES = {
  "#8AF0C8": "mint", "#6EE7FF": "sky", "#FF7AC6": "pink", "#FFC56E": "amber",
  "#B59BFF": "lilac", "#C4FF3F": "lime", "#1F8A5B": "green", "#D6336C": "rose",
  "#88C0D0": "frost", "#B58900": "bronze", "#7C6CFA": "violet",
};
const _ST_colorName = c => `${_ST_COLOR_NAMES[String(c).toUpperCase()] ?? "custom"} ${c}`;
function AccentSwatches({ value, themeAccent, colors, onChange }) {
  const { sameColor } = window.OMP_ACCENT;
  const own = sameColor(value, themeAccent);
  const idx = _ST_radioTabIndex(colors, own ? themeAccent : value, c => c);
  return (
    <div className="st-sw" role="radiogroup" aria-label="Accent" onKeyDown={_ST_radioKeyNav}>
      <button type="button" className="st-sw-theme" role="radio" aria-checked={own}
        aria-label={`theme accent ${themeAccent}`} title={`theme accent ${themeAccent}`}
        tabIndex={own ? 0 : -1} onClick={() => onChange(themeAccent)}>theme</button>
      {colors.map((c, i) => (
        <button type="button" key={c} role="radio" aria-checked={!own && sameColor(value, c)}
          aria-label={_ST_colorName(c)} title={_ST_colorName(c)} tabIndex={own ? -1 : idx(i)}
          style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** Icon strip of the sections. `counts[id]`: changed rows, or matches while
 *  `searching` (sections without a match dim). `hidden[id]`: changed rows
 *  that `visibleIf` currently hides (badge tooltip). While searching no
 *  section is `aria-selected` (the body is the search results, not a
 *  section panel). */
function SettingsStrip({ sections, active, counts, hidden, searching, onSelect }) {
  return (
    <div className="st-tabs" role="tablist" aria-label="Settings sections">
      {sections.map(s => {
        const n = counts[s.id] ?? 0;
        const hid = hidden?.[s.id] ?? 0;
        const selected = !searching && active === s.id;
        return (
          <React.Fragment key={s.id}>
            {s.sep && <span className="st-sep" />}
            <button type="button" role="tab" aria-selected={selected} aria-controls="st-body"
              tabIndex={selected || (searching && s === sections[0]) ? 0 : -1}
              className={`st-tab${searching && !n ? " dim" : ""}`} title={s.title} onClick={() => onSelect(s.id)}>
              <_ST_Icon name={s.icon} size={16} />
              <span className="st-tab-lbl">{s.title}</span>
              {n > 0 && (
                <span className={`st-badge${searching ? "" : " mod"}`}
                  title={searching ? `${n} matching` : `${n} changed from default${hid ? ` (includes ${hid} hidden)` : ""}`}>{n}</span>
              )}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

Object.assign(window, {
  SettingsMark, SettingsDesc, SettingsRow, SettingsToggle, SettingsSeg, SettingsSlider, SettingsButton,
  ThemeCards, AccentSwatches, SettingsStrip,
});
