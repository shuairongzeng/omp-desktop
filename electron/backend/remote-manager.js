/* electron/backend/remote-manager.js — the port's phone-control manager.

   Mirrors src-tauri/src/remote/mod.rs: owns the RemoteConnector (M4Crypto
   slice), persists remote.json through remote-files (M4RemoteFiles slice),
   and fans the connector's frames out as the three Tauri events the
   frontend subscribes to (remote-agent.js): `remote://phone` (a phone's
   cmd frames), `remote://control` (peer/pair/hello bookkeeping),
   `remote://status` (connector state for Settings → Remote). */

const tls = require("node:tls");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { RemoteConnector } = require("./remote-conn");
const remoteFiles = require("./remote-files");

// Frame types the desktop webview treats as control bookkeeping rather
// than phone commands (remote-agent.js listenTauri("remote://control")).
const CONTROL_TYPES = new Set(["peer", "pair_request", "pair_done", "hello", "device_info"]);

class RemoteManager extends EventEmitter {
  constructor() {
    super();
    this.connector = null;
    this.settings = remoteFiles.remoteSettingsLoad();
    this.status = this.settings?.enabled ? "connecting" : "off";
  }

  /** Rust's RemoteStateView (remote/mod.rs::view), field for field: the
   *  Settings page reads `device_id.slice(0, 12)`, `pinned_cert` and
   *  `device_name` off it — a renamed or missing field crashes the row. */
  view() {
    return {
      enabled: this.settings?.enabled === true,
      server: this.settings?.server ?? "",
      device_id: this.settings?.device_id ?? "",
      status: this.connector?.status ?? this.status,
      pinned_cert: Boolean(this.settings?.pinned_cert_pem?.trim()),
      device_name: this.settings?.device_name ?? "",
    };
  }

  _emitStatus() {
    const payload = { status: this.connector?.status ?? this.status, view: this.view() };
    this.emit("event", "remote://status", payload);
  }

  async configure({ enabled, server }) {
    const patch = { enabled: enabled === true };
    if (typeof server === "string" && server) patch.server = server;
    if (enabled && !this.settings?.device_id) {
      patch.device_id = crypto.randomBytes(32).toString("hex");
      patch.device_token = crypto.randomBytes(32).toString("hex");
    }
    this.settings = remoteFiles.remoteSettingsSave(patch);
    await this._restartConnector();
    return this.view();
  }

  async _restartConnector() {
    if (this.connector) {
      this.connector.stop();
      this.connector = null;
    }
    if (!this.settings?.enabled || !this.settings?.server || !this.settings?.device_token) {
      this.status = "off";
      this._emitStatus();
      return;
    }
    const conn = new RemoteConnector({
      deviceName: this.settings?.device_name ?? "",
      phones: this.settings?.phones ?? {},
    });
    this.connector = conn;
    conn.on("status", () => this._emitStatus());
    conn.on("frame", (frame) => {
      const name = CONTROL_TYPES.has(frame?.t) ? "remote://control" : "remote://phone";
      this.emit("event", name, frame);
    });
    conn.on("session", (info) => this.emit("event", "remote://control", { t: "session", ...info }));
    const url = `${String(this.settings.server).replace(/\/$/, "")}/ws?role=desktop&device=${this.settings.device_id}&token=${this.settings.device_token}`;
    conn.connect(url, { pinnedCertPem: this.settings?.pinned_cert_pem ?? "" }).catch(() => {
      this._emitStatus();
    });
    this._emitStatus();
  }

  send(frame) {
    if (!this.connector) return Promise.reject(new Error("remote is off"));
    return this.connector.send(frame);
  }

  setName(name) {
    this.settings = remoteFiles.remoteSettingsSave({ device_name: name });
    if (this.connector) this.connector.deviceName = name;
    return this.view();
  }

  /** Rust fetches the relay's leaf cert over TLS and pins it; Node can do
   *  the same with tls.connect + getPeerCertificate. */
  async trustServerCert() {
    const url = new URL(this.settings?.server ?? "");
    const pem = await new Promise((resolve, reject) => {
      const socket = tls.connect(
        { host: url.hostname, port: Number(url.port || 443), rejectUnauthorized: false, servername: url.hostname },
        () => {
          const cert = socket.getPeerCertificate(false);
          const der = cert?.raw;
          socket.end();
          if (!der) return reject(new Error("no certificate presented"));
          const b64 = der.toString("base64").match(/.{1,64}/g).join("\n");
          resolve(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`);
        },
      );
      socket.on("error", reject);
      socket.setTimeout(10000, () => { socket.destroy(); reject(new Error("certificate fetch timed out")); });
    });
    const next = remoteFiles.remoteSettingsSave({ pinned_cert_pem: pem });
    if (!next || typeof next.pinned_cert_pem !== "string") {
      throw new Error("the trust pin did not reach remote.json");
    }
    this.settings = next;
    await this._restartConnector();
    return this.view();
  }

  regenerateToken() {
    const patch = {
      device_id: crypto.randomBytes(32).toString("hex"),
      device_token: crypto.randomBytes(32).toString("hex"),
    };
    this.settings = remoteFiles.remoteSettingsSave(patch);
    this._restartConnector().catch(() => {});
    return this.view();
  }

  async shutdown() {
    if (this.connector) this.connector.stop();
    this.connector = null;
  }
}

module.exports = { RemoteManager };
