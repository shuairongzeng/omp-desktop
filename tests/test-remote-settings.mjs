// Settings → Remote trust prompt trigger (design/settings/rows-remote.jsx).
// The connector names an untrusted relay cert in the status line
// (conn.rs tls_failure_reason); the prompt must appear exactly then, and
// word itself as a re-trust when a cert is already pinned. Every other
// reconnect reason must NOT offer to trust a cert.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const Babel = createRequire(import.meta.url)(join(rootDir, "src/babel.min.js"));

const code = Babel.transform(
  readFileSync(join(rootDir, "src/design/settings/rows-remote.jsx"), "utf8"),
  { presets: ["react"] },
).code;
const win = {};
const ctx = {
  window: win,
  React: { useMemo: (f) => f(), useState: () => [null, () => {}], useEffect: () => {} },
};
new Function("window", "React", code)(win, ctx.React);
const { trustPrompt } = win.OMP_REMOTE_UI;

let n = 0;
const ok = (cond, msg) => { if (!cond) { console.error(`FAIL ${msg}`); process.exit(1); } n++; console.log(`  ok  ${msg}`); };

const st = (status, pinned_cert = false) => ({ enabled: true, server: "https://relay.example.com", device_id: "a".repeat(64), status, pinned_cert });

// The classified handshake failure — first trust.
ok(trustPrompt(st("reconnecting (certificate not trusted (self-signed?))")) === "first",
  "untrusted cert, no pin: first-trust prompt");
// A pinned cert that no longer matches (relay rotated): re-trust wording.
ok(trustPrompt(st("reconnecting (certificate not trusted (self-signed?))", true)) === "retrust",
  "untrusted cert with a pin stored: re-trust prompt");
// Other cert rejections classify too.
ok(trustPrompt(st("reconnecting (certificate rejected: Expired)")) === "first",
  "a rejected cert (expired) prompts as well");

// Everything else stays a plain status line: no cert to trust here.
for (const [status, why] of [
  ["reconnecting (error: connect timeout (15s))", "dead relay"],
  ["reconnecting (error: dns error: failed to lookup address)", "bad URL"],
  ["reconnecting (closed by relay: 4001)", "refused token"],
  ["reconnecting (connection ended)", "dropped link"],
  ["connecting", "first connect in flight"],
  ["online", "healthy"],
  ["off", "disabled"],
]) ok(trustPrompt(st(status)) === null, `no prompt on ${why} (${status})`);

// Disabled never prompts, whatever the status says.
ok(trustPrompt({ ...st("reconnecting (certificate not trusted (self-signed?))"), enabled: false }) === null,
  "disabled connector shows no prompt");
ok(trustPrompt(null) === null, "no state yet shows no prompt");

console.log(`remote-settings trust prompt: ${n} checks passed`);
