/* tools/deep/remote-relay.mjs — Settings → Remote end to end against the
   production relay, on a running packaged instance:

   1. open Settings → Remote, type the relay URL, click Enable: the device-id
      row must render (the crash this round fixed was `device_id.slice` on a
      view() that lacked the field) and no error boundary may catch.
   2. the self-signed relay must raise the TOFU trust prompt (status carries
      "certificate"), and clicking 信任证书 must pin the cert.
   3. with the device id registered on the relay (temporary entry, revoked
      afterwards), the status must reach online.

   Usage: node tools/deep/remote-relay.mjs <cdp-port> <relay-url>
   The relay's devices list is edited over ssh by the caller, not here. */

import { makeCtx } from "./ctx.mjs";

const port = Number(process.argv[2] ?? 9395);
const RELAY = process.argv[3] ?? "https://39.105.79.222.nip.io";
const ctx = await makeCtx(port, "/tmp/deep-remote-relay");
const { ev, sleep, assert } = ctx;

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name} — ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: String(error.message) });
    console.log(`FAIL ${name} — ${error.message}`);
  }
};

await check("remote-enable-renders", async () => {
  await ev(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').startsWith('settings ('))?.click()`);
  await sleep(1200);
  assert(await ev(`!!document.querySelector('.st-host:not([hidden]) .settings')`), "settings page did not open");
  await ev(`[...document.querySelectorAll('.st-host button, .st-host [role=button]')].find(b => (b.textContent||'').trim() === 'Remote')?.click()`);
  await sleep(1200);
  const input = await ev(`!!document.querySelector('.remote-server-input')`);
  assert(input, "the Remote section's server input is not on the page");
  await ev(`(() => { const i = document.querySelector('.remote-server-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(RELAY)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(400);
  await ev(`[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Enable')?.click()`);
  await sleep(2500);
  const boundary = await ev(`!!document.querySelector('.boundary, [class*="boundary"]')`);
  assert(!boundary, "an error boundary caught the enable click");
  const row = await ev(`document.querySelector('.remote-hint code')?.textContent ?? null`);
  assert(row && /^[0-9a-f]{12}…?$/.test(row), `the device-id row did not render (got ${row})`);
  return `device id row rendered (${row}) with no boundary`;
});

await check("remote-trust-prompt", async () => {
  let prompt = null;
  for (let i = 0; i < 12 && !prompt; i++) {
    await sleep(1500);
    prompt = await ev(`[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '信任证书') ? true : null`);
  }
  assert(prompt, "the self-signed relay never raised the TOFU trust prompt");
  const status = await ev(`window.OMP_BRIDGE.remoteGetState?.().then?.(s => s?.status) ?? null`);
  await ev(`[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '信任证书')?.click()`);
  await sleep(2500);
  const pinned = await ev(`(() => { const t = document.body.textContent || ''; return t.includes('已信任，指纹'); })()`);
  assert(pinned, "trusting the certificate did not report a fingerprint");
  return `trust prompt appeared (status ${status}) and pinned the cert`;
});

await check("remote-online", async () => {
  let status = "";
  for (let i = 0; i < 20 && status !== "online"; i++) {
    await sleep(2000);
    status = await ev(`window.OMP_BRIDGE.remoteGetState().then(s => s?.status ?? '')`);
  }
  assert(status === "online", `the connector never reached online (last status: ${status})`);
  return `connector online against ${RELAY}`;
});

await check("remote-disable-clean", async () => {
  await ev(`[...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === 'Disable')?.click()`);
  await sleep(1500);
  const status = await ev(`window.OMP_BRIDGE.remoteGetState().then(s => s?.status ?? '')`);
  assert(status === "off" || status === "", `disable left the connector at ${status}`);
  return `disable returns the connector to ${status}`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\nremote-relay: ${results.length - failed.length}/${results.length} pass`);
ctx.ws.close();
process.exit(failed.length ? 1 : 0);
