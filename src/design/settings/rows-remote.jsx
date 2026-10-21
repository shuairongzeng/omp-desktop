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
   modules are drawn as 1×1 rects so no markup string is injected. The
   library (57 KB) is needed only when the pairing modal actually opens, so
   it is injected on first use (the terminal's ensureXterm pattern); a
   failed load is not cached. */
let _srrQrcodeReady = null;
function _SRR_ensureQrcode() {
  if (window.qrcode) return Promise.resolve();
  if (!_srrQrcodeReady) {
    _srrQrcodeReady = new Promise((resolve, reject) => {
      const el = window.document.createElement("script");
      el.src = "qrcode.js";
      el.onload = () => resolve();
      el.onerror = () => { el.remove(); reject(new Error("could not load qrcode.js")); };
      window.document.head.appendChild(el);
    });
    _srrQrcodeReady = _srrQrcodeReady.catch((err) => { _srrQrcodeReady = null; throw err; });
  }
  return _srrQrcodeReady;
}

function _SRR_QrSvg({ text, size = 200 }) {
  const [libReady, setLibReady] = React.useState(!!window.qrcode);
  React.useEffect(() => {
    if (libReady) return undefined;
    let dead = false;
    _SRR_ensureQrcode().then(() => { if (!dead) setLibReady(true); })
      .catch((e) => console.warn("[remote] qrcode load failed:", e));
    return () => { dead = true; };
  }, [libReady]);
  const data = React.useMemo(() => {
    if (!libReady) return null;
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
  }, [text, libReady]);
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

/* The trust prompt's trigger, pure so a regression test can pin it: the
   connector classifies the one connect failure the user can fix here
   (conn.rs `tls_failure_reason` names the cert in the status), and a
   stored pin rewords the prompt as a re-trust. Everything else — a dead
   relay, a bad URL, a refused token — must NOT offer to trust a cert. */
function _SRR_trustPrompt(st) {
  if (!st || !st.enabled || !st.status.includes("certificate")) return null;
  return st.pinned_cert ? "retrust" : "first";
}
window.OMP_REMOTE_UI = { trustPrompt: _SRR_trustPrompt };

function _SRR_Main({ row, query }) {
  const { SettingsRow: Row, SettingsButton: Button, Icon } = window;
  const [st, setSt] = React.useState(null);
  const [server, setServer] = React.useState("");
  const [name, setName] = React.useState("");
  const [newToken, setNewToken] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    window.OMP_BRIDGE?.remoteGetState().then((v) => {
      if (v) { setSt(v); setServer(v.server); setName(v.device_name || ""); }
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

  const rename = async () => {
    if (!st || name === (st.device_name || "")) return;
    setError(null);
    const v = await window.OMP_BRIDGE.remoteSetName(name);
    if (v) setSt(v), setName(v.device_name || "");
    else setError("改名失败——检查配置目录可写。");
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
          <input
            className="remote-server-input"
            type="text"
            placeholder="设备名称（手机端的设备列表里显示；留空用计算机名）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={rename}
            spellCheck={false}
            maxLength={80}
          />
        )}
        {st?.enabled && (
          <div className="remote-hint">
            <Icon name="phone" size={11} />
            设备 ID：<code>{st.device_id.slice(0, 12)}…</code>
            <Button onClick={regenerate}>重新生成令牌</Button>
          </div>
        )}
        {st?.enabled && _SRR_trustPrompt(st) && (
          <div className="remote-token-box">
            <div>
              {_SRR_trustPrompt(st) === "retrust"
                ? "服务器证书与已信任的不一致（relay 换了证书？）。重新信任当前证书（TOFU，之后只认这一张）："
                : "TLS 校验失败（自签证书？）。信任服务器证书（TOFU，之后只认这一张）："}
            </div>
            <div className="remote-token-line">
              <Button onClick={async () => {
                setError(null);
                const fp = await window.OMP_BRIDGE.remoteTrustServerCert();
                if (fp) setNewToken(null), setError(`已信任，指纹：${fp}`);
                else setError("抓取证书失败——检查 relay 地址与网络。");
              }}>信任证书</Button>
            </div>
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
  // Click-to-copy feedback for the pairing modal: "url" | "code" for 1.5s.
  // The revoke's armed row ("吊销?" for a second click): profile-menu.jsx's
  // inline-confirm pattern, timing out 3s after arming.
  const [armedRevoke, setArmedRevoke] = React.useState(null);
  const revokeTimer = React.useRef(null);
  const armRevoke = (hash) => {
    clearTimeout(revokeTimer.current);
    setArmedRevoke(hash);
    revokeTimer.current = setTimeout(() => setArmedRevoke(null), 3000);
  };
  React.useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(revokeTimer.current); }, []);
  const copyPairText = (text, what) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(null), 1500);
    }, () => setError("复制失败：剪贴板不可用"));
  };

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
    setCopied(null);
    window.OMP_BRIDGE?.remoteSend({ t: "pair_begin" }).catch((e) => setError(String(e?.message || e)));
  };

  // Two-step revoke: the first click only arms ("吊销?"), the second within
  // 3s actually revokes; anything else disarms (armRevoke's timer or a
  // different row's first click).
  const revoke = (hash) => {
    if (armedRevoke !== hash) { armRevoke(hash); setError(null); return; }
    clearTimeout(revokeTimer.current);
    setArmedRevoke(null);
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
              <Button accent={armedRevoke === p.hash}
                title={armedRevoke === p.hash ? "再点一次确认吊销该手机" : `吊销 ${p.name || "该手机"} 的访问`}
                onClick={() => revoke(p.hash)}>
                {armedRevoke === p.hash ? "吊销?" : <><Icon name="trash" size={11} />吊销</>}
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="remote-error">{error}</div>}
      {qr && (
        <div className="bridge-scrim" onClick={() => setQr(null)}>
          <div className="bridge remote-qr-modal" onClick={(e) => e.stopPropagation()}>
            <div className={`remote-qr-title${copied ? " copied" : ""}`}>
              {copied === "url" ? "✓ 链接已复制，发给手机打开即可"
                : copied === "code" ? "✓ 配对码已复制"
                : "扫码配对，或复制链接发给手机"}
            </div>
            <button type="button" className="remote-qr-copy" title="点击复制配对链接"
              onClick={() => copyPairText(qr.url, "url")}>
              <_SRR_QrSvg text={qr.url} />
            </button>
            <div className="remote-qr-url" title="点击复制配对链接" onClick={() => copyPairText(qr.url, "url")}>{qr.url}</div>
            <div className="remote-qr-code">配对码：<code title="点击复制" onClick={() => copyPairText(qr.code, "code")}>{qr.code}</code>（点码复制）</div>
            <div className="remote-hint">配对码 5 分钟内有效、只能用一次。打开链接后需要在这台电脑上点“允许”。微信内收到链接请选择在浏览器中打开。</div>
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
