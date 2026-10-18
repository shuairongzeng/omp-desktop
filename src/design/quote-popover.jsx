/* design/quote-popover.jsx — the floating "Add to prompt" pill that
   appears next to a finished chat selection (app-live.jsx drives it;
   rules in app/quote-selection.js). Fixed-position, outside the chat
   scroll so a scroll can't drag it along; the text was captured when the
   selection finished, so a click collapsing the selection loses nothing.
   `onMouseDown` preventDefault keeps the highlight alive until the
   click lands. */
function QuotePopover({ x, y, onPick }) {
  const { Icon: _QP_Icon } = window;
  return (
    <button type="button" className="quote-pop" style={{ left: x, top: y }}
      onMouseDown={e => e.preventDefault()} onClick={onPick}>
      <_QP_Icon name="quote" size={11} />
      <span>Add to prompt</span>
    </button>
  );
}
window.QuotePopover = QuotePopover;
