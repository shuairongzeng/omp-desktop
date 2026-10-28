/* port-shim.js — renderer-main-world half of the `window.__TAURI__` shim.

   Injected into dist/index.html by scripts/port-dist.mjs (port branch
   only; the Tauri build never sees it). It exists because Electron's
   contextBridge cannot marshal a Channel: a class is not constructible
   across the bridge and an `onmessage` assignment on a marshalled object
   stays renderer-local. Tauri solves this the same way — its Channel class
   lives in the renderer (@tauri-apps/api), crosses the wire as an id
   (toJSON), and receives frames through a renderer-side listener.

   Here the Channel class lives in the main world; its `onmessage` setter
   hands the handler FUNCTION to the isolated preload through
   `__OMP_PRIMS__.channelHandler` (contextBridge marshals function
   arguments as cross-world proxies), and the preload calls it back when a
   frame arrives on ipc `omp:channel`. */

(function () {
  const P = window.__OMP_PRIMS__;
  if (!P) return; // not the Electron port runtime

  class Channel {
    constructor(onmessage) {
      this.id = P.channelCreate();
      this._onmessage = null;
      if (onmessage) this.onmessage = onmessage;
    }

    get onmessage() {
      return this._onmessage;
    }

    set onmessage(fn) {
      this._onmessage = fn;
      P.channelHandler(this.id, fn);
    }

    // invoke args are JSON-serialised by core.invoke below, so this is what
    // crosses: the id, exactly like Tauri's {__TAURI_CHANNEL__: id}.
    toJSON() {
      return { __channel: this.id };
    }
  }

  window.__TAURI__ = {
    core: {
      // JSON round-trip honours toJSON (structured clone does not), which
      // is what reduces a Channel to its id on the wire.
      //
      // The dispatcher answers unimplemented/failed commands with the
      // single-key envelope {error}; Tauri turns a Rust Err into an IPC
      // rejection, so the shim throws and _invokeSafe/_invokeResult behave
      // exactly as against the real backend.
      invoke: (name, args) =>
        P.invoke(name, JSON.parse(JSON.stringify(args ?? {}))).then((r) => {
          if (r && typeof r === "object" && typeof r.error === "string" && Object.keys(r).length === 1) {
            throw new Error(r.error);
          }
          return r;
        }),
      Channel,
    },
    event: {
      listen: (name, handler) => P.listen(name, handler),
      emit: () => Promise.resolve(),
    },
    window: {
      getCurrentWindow: () => ({
        show: () => Promise.resolve(),
        setFocus: () => Promise.resolve(),
        setTitle: () => Promise.resolve(),
        listen: () => Promise.resolve(() => {}),
        close: () => P.winOp("close"),
        minimize: () => P.winOp("minimize"),
        maximize: () => P.winOp("maximize"),
        unmaximize: () => P.winOp("unmaximize"),
        isMaximized: () => P.winOp("isMaximized"),
        startDragging: () => P.winOp("startDragging"),
        onDragDropEvent: () => Promise.resolve(() => {}),
      }),
    },
    webview: {
      getCurrentWebview: () => ({
        // The preload's DOM listeners carry the real paths; Tauri's payload
        // shape is { type, paths, position } in physical pixels.
        onDragDropEvent: (handler) =>
          P.dragDrop((payload) => handler({ payload })),
        setZoom: () => Promise.resolve(),
      }),
    },
    internals: {},
  };
})();
