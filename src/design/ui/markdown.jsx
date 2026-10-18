/* ui/markdown.jsx — Markdown renderer using marked + highlight.js
   when available; falls back to plain text with HTML escaping. */

const { copyCodeBlockClick: _MdCopyClick } = window;

// Clicks in rendered markdown, delegated on its container: the code blocks'
// copy buttons, then links — `MarkdownLinkContext` carries a handler
// (app-live.jsx: the browser panel's localhost links), null for none.
const MarkdownLinkContext = React.createContext(null);
function useMarkdownClick() {
  const onLink = React.useContext(MarkdownLinkContext);
  return React.useCallback((e) => { _MdCopyClick(e); onLink?.(e); }, [onLink]);
}

const escapeText = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Markdown renderer — uses marked + highlight.js when available ─────────
const MarkdownContent = ({ text, streaming }) => {
  const html = React.useMemo(() => {
    if (!text) return '';
    if (!window.marked) {
      // marked not loaded — render plain text with escaped HTML
      return '<p>' + escapeText(text)
        .replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }
    // While the bubble streams, fences render as plain escaped <code>
    // (marked-setup.js's skipHighlight): a partial fence highlighted
    // mid-stream yields malformed spans — eval-cell.jsx refuses to
    // highlight a running cell for the same reason — and hljs per delta
    // is the parse path's dominant cost while streaming. The settle
    // flips the memo key (a new text), which highlights once, final.
    const md = window.OMP_MARKDOWN;
    const prev = md?.skipHighlight;
    if (md) md.skipHighlight = !!streaming;
    let out;
    try { out = window.marked.parse(text); }
    catch (_) { out = '<pre>' + escapeText(text) + '</pre>'; }
    finally { if (md) md.skipHighlight = prev; }
    return out;
    // `streaming` in the key: the settled parse (highlighted) must not
    // reuse the streaming parse (escaped) of the same final text.
  }, [text, streaming]);

  const onClick = useMarkdownClick();
  return (
    <div
      className={`md-content selectable${streaming ? ' md-streaming' : ''}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};


Object.assign(window, { MarkdownContent, MarkdownLinkContext, useMarkdownClick });
