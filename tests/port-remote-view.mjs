#!/usr/bin/env node
/* Shape test for electron/backend/remote-manager.js view(): the Settings →
   Remote page (src/design/settings/rows-remote.jsx) reads Rust's
   RemoteStateView field names off it — `st.device_id.slice(0, 12)` crashes
   the row on a missing field (measured: "Cannot read properties of
   undefined (reading slice)" after clicking Enable). The contract is
   remote/mod.rs::view, field for field. Run: node tests/port-remote-view.mjs */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "port-remote-view-"));
process.env.OMP_PORT_CONFIG_DIR = dir;

const seed = {
  enabled: true,
  server: "https://relay.example/",
  device_id: "0123456789abcdef0123456789abcdef",
  device_token: "ff".repeat(32),
  device_name: "desk",
  pinned_cert_pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
  phones: {},
};
writeFileSync(join(dir, "remote.json"), JSON.stringify(seed, null, 2));

const { RemoteManager } = require("../electron/backend/remote-manager.js");

test("view() carries every RemoteStateView field the Settings page reads", () => {
  const manager = new RemoteManager();
  const view = manager.view();
  manager.connector?.stop?.();
  for (const key of ["enabled", "server", "device_id", "status", "pinned_cert", "device_name"]) {
    assert.ok(key in view, `view() is missing ${key} (rows-remote.jsx reads it)`);
  }
  assert.equal(typeof view.device_id, "string");
  assert.equal(view.device_id.slice(0, 12), "0123456789ab", "the row's 12-char id must render");
  assert.equal(view.enabled, true);
  assert.equal(view.server, "https://relay.example/");
  assert.equal(view.pinned_cert, true);
  assert.equal(view.device_name, "desk");
  assert.equal(typeof view.status, "string");
});

test("view() survives an empty store without a crash-shaped hole", () => {
  writeFileSync(join(dir, "remote.json"), "{}");
  const view = new RemoteManager().view();
  assert.equal(view.enabled, false);
  assert.equal(view.device_id, "");
  assert.equal(view.pinned_cert, false);
  assert.equal(view.device_name, "");
  assert.equal(typeof view.status, "string");
  // The row only slices device_id when enabled; an off store must stay off.
  assert.equal(view.enabled && view.device_id.slice(0, 12), false);
});

test("a pinned self-signed LEAF cert connects (rustls parity: CA:FALSE leaf as its own anchor)", async () => {
  // The relay's cert is a self-signed leaf (Basic Constraints CA:FALSE):
  // OpenSSL rejects it as a `ca` anchor (UNABLE_TO_VERIFY_LEAF_SIGNATURE)
  // while rustls accepts it. tlsOptions must pin such a leaf by DER
  // equality and refuse any other cert.
  const { tlsOptions } = require("../electron/backend/remote-conn.js");
  // A real self-signed leaf (CA:FALSE), generated once with openssl:
  const pem = `-----BEGIN CERTIFICATE-----
MIIC5zCCAc+gAwIBAgIUUqVdjmwy+4tRNT5vsatV9KUtlR8wDQYJKoZIhvcNAQEL
BQAwFTETMBEGA1UEAwwKcmVsYXkudGVzdDAeFw0yNjEwMjgxMzQ4NDRaFw0yNjEx
MjcxMzQ4NDRaMBUxEzARBgNVBAMMCnJlbGF5LnRlc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDtbak+qcExZUsyXSdz7YkczD5N9ZszdNymNQN8HWz7
ekqUS43d9N/6n9pje8UmaWgZmkmMcyGtgOLICzVpVhpAswjr1IamityJaCUPvd9f
L5Pq7gWe8iDHm8IV4EinB3CIQ7mrnQ0Glveru54KeoXYE1PYEPNr2Fes4AR0AOzL
jmRfuZ0SkvDsJY8Y9yFaOTRCXQOA38n8NgLPuAaEHPzX8ukAkLhI/xjwze6B2Gbx
/eaRk32b0tqfbGmG37jYZRBxxu9SAR4eZC7l1sJYgo4kAsrTqmgTpe03N6Pa54+J
AGVaGJldzCNgn/fRV8vF746SpPRPNvCWGN6Gjh00z+4xAgMBAAGjLzAtMB0GA1Ud
DgQWBBQynNI0A8xdHUeuo12f3HXnlY6o3TAMBgNVHRMBAf8EAjAAMA0GCSqGSIb3
DQEBCwUAA4IBAQCxVVkTQwvfZNDDyQVwsOa6CdKI1jIeHNUn6QcsjeRSlBSkvusS
q1S732YM0VoX0EDH25GS3YHsnPvXDeM9+4cafwdtaG39yqSAQJFj7x0TNgXvY/j1
9dZHU6uBs4CkQoEgVRyJYKElWDjBswslv5ts3ayywhhzHyBz5ruWa8KHQf6a9Ynw
hY0HAPcFdlYtcjwQsNWTE9jmZwyVqIiJ4gQGL2nW/8dptPToZwUF+qFydPRR0tfe
1F6SyLVa04ZwaCjlD7HWc8EZvEWfkrAz1J9BHGQ/PtdckpWszun5Wh64gSBoQg2x
nNudyPi46DzpmiOKAUt20oEZzPnW4soasCtB
-----END CERTIFICATE-----`;

  const opts = tlsOptions(pem);
  assert.equal(opts.rejectUnauthorized, false, "a self-signed leaf pin checks identity itself");
  assert.equal(typeof opts.checkServerIdentity, "function");
  const der = Buffer.from(pem.split(/\r?\n/).filter((l) => !l.startsWith("-----")).join(""), "base64");
  assert.equal(opts.checkServerIdentity("h", { raw: der }), undefined, "the pinned leaf itself must pass");
  const other = Buffer.from(der); // same length, one flipped byte
  other[10] ^= 0xff;
  assert.throws(() => { const r = opts.checkServerIdentity("h", { raw: other }); if (r) throw r; }, /pinned certificate mismatch/);
  // No pin / unparsable pin: system roots, exactly like Rust's None.
  assert.deepEqual(tlsOptions(""), { rejectUnauthorized: true });
  assert.deepEqual(tlsOptions("-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----"), { rejectUnauthorized: true });
});

test("an enabled ready store connects at construction (Rust starts at setup)", () => {
  writeFileSync(join(dir, "remote.json"), JSON.stringify({
    enabled: true, server: "http://127.0.0.1:1/", device_id: "aa".repeat(32), device_token: "bb".repeat(32),
  }));
  const manager = new RemoteManager();
  assert.ok(manager.connector, "a restarted app with an enabled ready store must boot its connector");
  manager.connector.stop();
});

test("configure() enables into a full view (the Enable click's reply)", async () => {
  writeFileSync(join(dir, "remote.json"), JSON.stringify({ server: "https://relay.example/" }));
  const manager = new RemoteManager();
  // an unroutable loopback port: the connector fails fast, no DNS, no retry storm
  const view = await manager.configure({ enabled: true, server: "http://127.0.0.1:1/" });
  assert.equal(view.enabled, true);
  assert.match(view.device_id, /^[0-9a-f]{64}$/, "enabling must mint the device id the row slices");
  assert.equal(view.pinned_cert, false);
  manager.connector?.stop?.();
});
