/* ═════════════════════════════════════════════════════════════════════
   design/settings/rows-remote.jsx — the Remote settings section
   (window.OMP_SETTINGS_ROWS; docs/architecture/remote-control.md):
     remoteMain  enable toggle, relay URL, one-time device token reveal
     remotePair  QR pairing for a new phone + the paired-phone list with
                 revoke
   Both talk to the Rust connector through OMP_BRIDGE's remote* methods;
   pairing codes and phone lists arrive as `remote-control` window events
   (forwarded by app/remote-agent.js from the connector).
   ═════════════════════════════════════════════════════════════════════ */

/* QR for the pairing URL. qrcode-generator is vendored at src/qrcode.js;
   modules are drawn as 1×1 rects so no markup string is injected. */
function _SRR_QrSvg({ text, size = 200 }) {
  const data = React.useMemo(() => {
    try {
      const q = window.qrcode(0, "M");
      q.addData(text);
      q.make();
      const n = q.getModuleCount();
      const cells = [];
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++)
          if (q.isDark(r, c)) cells.push(`${c},${r}`);
      return { n, cells };
    } catch { return null; }
  }, [text]);
  if (!data) return null;
  return (
    <svg className="remote-qr-svg" width={size} height={size}
      viewBox={`-4 -4 ${data.n + 8} ${data.n + 8}`} role="img" aria-label="pairing QR code">
      <rect x="-4" y="-4" width={data.n + 8} height={data.n + 8} fill="#fff" />
      {data.cells.map((k) => {
        const [x, y] = k.split(",");
        return <rect key={k} x={+x} y={+y} width="1.02" height="1.02" fill="#000" />;
      })}
    </svg>
  );
}

function _SRR_StatusDot({ status }) {
  const cls = status === "online" ? "ok" : status === "off" ? "off" : "warn";
  return <span className={`remote-status-dot ${cls}`} title={status} />;
}

function _SRR_Main({ row, query }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const [st, setSt] = React.useState(null);
  const [server, setServer] = React.useState("");
  const [newToken, setNewToken] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    window.OMP_BRIDGE?.remoteGetState().then((v) => {
      if (v) { setSt(v); setServer(v.server); }
    });
    // Live status changes (connecting → online → reconnecting) arrive as
    // connector events.
    const onStatus = (e) => setSt((prev) => (prev ? { ...prev, ...e.detail } : prev));
    window.addEventListener("remote-status", onStatus);
    return () => window.removeEventListener("remote-status", onStatus);
  }, []);

  const apply = async (enabled, url) => {
    setError(null);
    const v = await window.OMP_BRIDGE.remoteConfigure(enabled, (url ?? server).trim());
    if (v) setSt(v);
    else setError("保存失败——检查配置目录可写。");
  };

  const regenerate = async () => {
    setError(null);
    const token = await window.OMP_BRIDGE.remoteRegenerateToken();
    if (token) setNewToken(token);
    else setError("生成失败。");
  };

  const copyToken = () => {
    navigator.clipboard?.writeText(newToken || "").catch(() => {});
  };

  return (
    <Row stack label={row.label} desc={row.desc} query={query}
      aside={(
        <>
          {st && <span className="remote-status"><_SRR_StatusDot status={st.status} />{st.status}</span>}
          {st && (
            <Button onClick={() => apply(!st.enabled)}>
              {st.enabled ? "Disable" : "Enable"}
            </Button>
          )}
        </>
      )}>
      <div className="remote-form">
        <input
          className="remote-server-input"
          type="text"
          placeholder="https://relay.example.com"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          onBlur={() => { if (st && server.trim() !== st.server) apply(st.enabled, server); }}
          spellCheck={false}
        />
        {st?.enabled && (
          <div className="remote-hint">
            <Icon name="phone" size={11} />
            设备 ID：<code>{st.device_id.slice(0, 12)}…</code>
            <Button onClick={regenerate}>重新生成令牌</Button>
          </div>
        )}
        {newToken && (
          <div className="remote-token-box">
            <div>把下面令牌写入服务器 <code>relay-config.json</code>（只显示这一次）：</div>
            <div className="remote-token-line">
              <code>{newToken}</code>
              <Button onClick={copyToken}><Icon name="copy" size={11} />复制</Button>
            </div>
            <div className="remote-hint">relay 配置形如：<code>"devices": {'{"<设备ID>": "<令牌的 sha256>"}'}</code>，设备 ID 完整值见 <code>remote.json</code>。</div>
          </div>
        )}
        {error && <div className="remote-error">{error}</div>}
      </div>
    </Row>
  );
}

function _SRR_Pair({ row, query }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const [qr, setQr] = React.useState(null);
  const [phones, setPhones] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [st, setSt] = React.useState(null);

  React.useEffect(() => {
    window.OMP_BRIDGE?.remoteGetState().then(setSt);
    const onCtl = (e) => {
      const f = e.detail || {};
      if (f.t === "pair_code") setQr({ url: f.url, code: f.code });
      else if (f.t === "phones") setPhones(f.list);
      else if (f.t === "revoked") refreshPhones();
    };
    const onStatus = (e) => setSt((prev) => (prev ? { ...prev, ...e.detail } : e.detail));
    window.addEventListener("remote-control", onCtl);
    window.addEventListener("remote-status", onStatus);
    return () => {
      window.removeEventListener("remote-control", onCtl);
      window.removeEventListener("remote-status", onStatus);
    };
  }, []);

  const refreshPhones = () => {
    setError(null);
    window.OMP_BRIDGE?.remoteSend({ t: "list_phones" }).catch((e) => setError(String(e?.message || e)));
  };

  const pair = () => {
    setError(null);
    setQr(null);
    window.OMP_BRIDGE?.remoteSend({ t: "pair_begin" }).catch((e) => setError(String(e?.message || e)));
  };

  const revoke = (hash) => {
    setError(null);
    window.OMP_BRIDGE?.remoteSend({ t: "revoke", phone_hash: hash }).catch((e) => setError(String(e?.message || e)));
  };

  const online = st?.enabled && st?.status === "online";

  return (
    <Row stack label={row.label} desc={row.desc} query={query}
      aside={(
        <>
          <Button onClick={refreshPhones} disabled={!online}><Icon name="refresh" size={11} />刷新列表</Button>
          <Button onClick={pair} disabled={!online}><Icon name="phone" size={11} />配对新手机</Button>
        </>
      )}>
      {!online && (
        <div className="remote-hint">先在上面启用并连上 relay（状态显示 online）再配对。</div>
      )}
      {phones && phones.length === 0 && <div className="remote-hint">还没有已配对的手机。</div>}
      {phones && phones.length > 0 && (
        <div className="remote-phones">
          {phones.map((p) => (
            <div key={p.hash} className="remote-phone-row">
              <Icon name="phone" size={11} />
              <span className="remote-phone-name" title={p.hash}>{p.name || "未知设备"}</span>
              <span className="remote-phone-date">{String(p.paired_at || "").slice(0, 10)}</span>
              <Button onClick={() => revoke(p.hash)}><Icon name="trash" size={11} />吊销</Button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="remote-error">{error}</div>}
      {qr && (
        <div className="bridge-scrim" onClick={() => setQr(null)}>
          <div className="bridge remote-qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className="remote-qr-title">用手机相机扫码配对</div>
            <_SRR_QrSvg text={qr.url} />
            <div className="remote-qr-code">或输入配对码：<code>{qr.code}</code></div>
            <div className="remote-hint">配对码 5 分钟内有效、只能用一次。打开链接后需要在这台电脑上点“允许”。</div>
            <Button onClick={() => setQr(null)}>关闭</Button>
          </div>
        </div>
      )}
    </Row>
  );
}

Object.assign(window.OMP_SETTINGS_ROWS = window.OMP_SETTINGS_ROWS || {}, {
  remoteMain: _SRR_Main,
  remotePair: _SRR_Pair,
});
