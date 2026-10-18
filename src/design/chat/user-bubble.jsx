/* chat/user-bubble.jsx — user-side bubble, right-aligned. */
const { ImageThumbs: _UB_ImageThumbs, Icon: _UB_Icon } = window;

function UserBubble({ msg, idx, highlighted }) {
  return (
    <div className={`row user fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="user-bubble selectable">
        <div className="user-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>{msg.time}</span>
          <span className="chip muted">you</span>
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
