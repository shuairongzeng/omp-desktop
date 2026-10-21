/* chat/user-bubble.jsx — user-side bubble, right-aligned. */
const { ImageThumbs: _UB_ImageThumbs, Icon: _UB_Icon, CopyButton: _UB_Copy } = window;

function UserBubble({ msg, idx, highlighted }) {
  return (
    <div className={`row user fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="user-bubble selectable">
        <div className="user-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>{msg.time}</span>
          <span className="chip muted">you</span>
          {/* Same reveal system as the assistant meta copy (chat.css
              .copy-btn rules): hidden until the row hovers, always on
              under (hover:none). CopyButton renders nothing for empty
              text, so an images-only bubble shows no button. */}
          <_UB_Copy className="user-copy" label="Copy message" text={msg.text} />
        </div>
        <_UB_ImageThumbs images={msg.images} className="user-images" alt="attached image" />
        {msg.text && <div className="user-text">{msg.text}</div>}
      </div>
      {/* Right rail mirrors the assistant's left one, minus the thread:
          user messages are not chained together. */}
      <div className="user-rail">
        <div className="user-glyph">
          <_UB_Icon name="user" size={11} color="var(--fg-2)" />
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { UserBubble });
