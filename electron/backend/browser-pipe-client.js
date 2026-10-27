/* electron/backend/browser-pipe-client.js — a direct CDP client on the pipe.

   Port-only deviation, measured 2026-10-27 on Chrome 156 / CfT 150 with
   `--remote-debugging-pipe`: the broker's client path (page session attached
   under the broker's root session, ids rewritten) never delivers LARGE
   replies — `Page.captureScreenshot` and `Page.screencastFrame` time out
   while a raw speaker on the same pipe, attaching the page session at
   BROWSER level with its own id space, gets every frame. Small commands
   work on both paths, so the failure is specific to the broker's
   root-nested large-reply routing; the raw pattern is what this client
   implements. The broker keeps serving the agent-facing proxy (its traffic
   is small commands plus events, verified working); the panel's screencast
   path uses this client until the broker difference is root-caused.

   Id space starts at 10_000_000 so our ids never collide with the broker's
   rewritten wire ids on the shared pipe. */

const { EventEmitter } = require("node:events");

const ID_BASE = 10_000_000;

class PipeClient extends EventEmitter {
  constructor(pipes) {
    super();
    this._to = pipes.toChromium;
    this._nextId = ID_BASE;
    this._pending = new Map();
    this._sessions = new Map(); // targetId -> flattened sessionId
    this._raw = Buffer.alloc(0);
    this._closed = false;
    pipes.fromChromium.on("data", (chunk) => this._feed(chunk));
    for (const ev of ["end", "close", "error"]) {
      pipes.fromChromium.once(ev, () => {
        this._closed = true;
        for (const p of this._pending.values()) p.reject(new Error("cdp pipe closed"));
        this._pending.clear();
        this.emit("close");
      });
    }
  }

  _feed(chunk) {
    this._raw = Buffer.concat([this._raw, chunk]);
    let i;
    while ((i = this._raw.indexOf(0)) !== -1) {
      const text = this._raw.subarray(0, i).toString("utf8");
      this._raw = this._raw.subarray(i + 1);
      let v;
      try {
        v = JSON.parse(text);
      } catch {
        continue;
      }
      if (v.id != null && this._pending.has(v.id)) {
        const p = this._pending.get(v.id);
        this._pending.delete(v.id);
        if (v.error) {
          const err = new Error(typeof v.error.message === "string" ? v.error.message : "CDP error");
          err.code = v.error.code;
          p.reject(err);
        } else {
          p.resolve(v.result);
        }
        continue;
      }
      if (typeof v.method === "string") {
        this.emit("event", { method: v.method, params: v.params ?? {}, sessionId: v.sessionId });
      }
    }
  }

  /** One CDP command; `opts.sessionId` addresses a flattened page session
   *  (sent browser-level, which is what the measurements showed working). */
  send(method, params = {}, opts = {}) {
    if (this._closed) return Promise.reject(new Error("cdp pipe closed"));
    const id = this._nextId++;
    const message = { id, method, params: params ?? {} };
    if (opts?.sessionId) message.sessionId = opts.sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._to.write(`${JSON.stringify(message)}\0`, (err) => {
        if (err && this._pending.has(id)) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** The flattened session of `targetId`, attached once and cached. */
  async sessionFor(targetId) {
    const cached = this._sessions.get(targetId);
    if (cached) return cached;
    const r = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = r?.sessionId;
    if (!sessionId) throw new Error("attach reply has no sessionId");
    this._sessions.set(targetId, sessionId);
    return sessionId;
  }

  close() {
    this._closed = true;
    for (const p of this._pending.values()) p.reject(new Error("cdp pipe closed"));
    this._pending.clear();
  }
}

module.exports = { PipeClient };
