/* design/remote-pair-dialog.jsx — the desktop's approve/deny prompt when a
   phone redeems a pairing code (docs/architecture/remote-control.md).
   remote-agent.js turns the relay's `pair_request` into a window event;
   answering sends `pair_grant`/`pair_deny` back through the connector. */

function RemotePairDialog() {
  const { Icon } = window;
  const [req, setReq] = React.useState(null);

  React.useEffect(() => {
    const onReq = (e) => setReq(e.detail || null);
    window.addEventListener("remote-pair-request", onReq);
    return () => window.removeEventListener("remote-pair-request", onReq);
  }, []);

  if (!req) return null;

  const answer = (grant) => {
    window.OMP_BRIDGE?.remoteSend({ t: grant ? "pair_grant" : "pair_deny", pair_id: req.pair_id })
      .catch((e) => console.warn("[remote] pair respond:", e));
    setReq(null);
  };

  return (
    <div className="bridge-scrim" role="presentation">
      <div className="bridge remote-pair-modal" role="alertdialog" aria-label="phone pairing request">
        <div className="remote-pair-title">
          <Icon name="phone" size={14} color="var(--accent)" />
          手机请求配对
        </div>
        <div className="remote-pair-agent" title={req.agent || ""}>
          {req.agent || "未知设备"}
        </div>
        <div className="remote-pair-hint">
          只允许你刚刚扫码的那台手机。配对后它能完全控制这台电脑上的 OMP
          Desktop（读消息、发指令、批准工具调用）。
        </div>
        <div className="remote-pair-actions">
          <button className="btn ghost" onClick={() => answer(false)}>拒绝</button>
          <button className="btn primary" onClick={() => answer(true)}>允许配对</button>
        </div>
      </div>
    </div>
  );
}

window.RemotePairDialog = RemotePairDialog;
