#!/usr/bin/env node
// Regression script for src/app/dropped-paths.js — splitting dropped/copied
// paths into attachable images vs text paths, and the prompt text a path
// insert produces.
// Run: node tests/test-dropped-paths.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src  = readFileSync(join(root, "src/app/dropped-paths.js"), "utf8");
const win  = {};
// eslint-disable-next-line no-new-func
new Function("window", src)(win);
const D = win.OMP_DROPPED;

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

// ── splitDroppedPaths ─────────────────────────────────────────────────────

check("decodable extensions are images, everything else is a text path", () => {
  const { images, others } = D.splitDroppedPaths([
    "C:\\shots\\a.png", "/home/u/photo.JPG", "/tmp/no-ext", "D:\\docs\\spec.txt", "/x/folder",
  ]);
  assert.deepEqual(images, [
    { path: "C:\\shots\\a.png", name: "a.png", mime: "image/png" },
    { path: "/home/u/photo.JPG", name: "photo.JPG", mime: "image/jpeg" },
  ]);
  assert.deepEqual(others, ["/tmp/no-ext", "D:\\docs\\spec.txt", "/x/folder"]);
});

check("a folder named like an image is classified by its extension only", () => {
  // The read command's "not a file" refusal heals this; the point here is
  // that classification is purely the name's extension.
  const { images } = D.splitDroppedPaths(["C:\\assets.png"]);
  assert.equal(images.length, 1);
});

check("empty and junk entries survive without throwing", () => {
  assert.deepEqual(D.splitDroppedPaths([]), { images: [], others: [] });
  assert.deepEqual(D.splitDroppedPaths(null), { images: [], others: [] });
  assert.deepEqual(D.splitDroppedPaths(["", undefined]), { images: [], others: [] });
});

// ── quotePath ─────────────────────────────────────────────────────────────

check("plain paths stay bare; whitespace or quotes force quoting", () => {
  assert.equal(D.quotePath("C:\\repo\\a.txt"), "C:\\repo\\a.txt");
  assert.equal(D.quotePath("/home/u/my file.txt"), '"/home/u/my file.txt"');
  assert.equal(D.quotePath('C:\\say "hi".txt'), '"C:\\say \\"hi\\".txt"');
});

// ── pathsInsertText ───────────────────────────────────────────────────────

check("an empty draft takes bare space-separated paths with a trailing space", () => {
  const r = D.pathsInsertText("", 0, 0, ["C:\\a.txt", "/x/y z"]);
  assert.deepEqual(r.range, { start: 0, end: 0 });
  assert.equal(r.insert, 'C:\\a.txt "/x/y z" ');
});

check("insertion between word chars pads both sides; between spaces, neither", () => {
  // "seeh|ere" — caret between two word chars: both sides pad.
  const r = D.pathsInsertText("seehere", 4, 4, ["/p"]);
  assert.equal(r.insert, " /p ");
  // "see  |here" — caret between two spaces: neither side pads.
  const s = D.pathsInsertText("see  here", 4, 4, ["/p"]);
  assert.equal(s.insert, "/p");
  // "see |here" — caret right after the single space: no leading pad.
  const t = D.pathsInsertText("see here", 4, 4, ["/p"]);
  assert.equal(t.insert, "/p ");
});

check("a selection is replaced; a trailing space always follows the paths", () => {
  // "open |this|" — preceded by a space: no leading pad; the trailing space
  // keeps whatever is typed next from gluing onto the path.
  const r = D.pathsInsertText("open this", 5, 9, ["/a"]);
  assert.deepEqual(r.range, { start: 5, end: 9 });
  assert.equal(r.insert, "/a ");
});

check("no paths means no insert", () => {
  assert.equal(D.pathsInsertText("x", 1, 1, []), null);
  assert.equal(D.pathsInsertText("", 0, 0, null), null);
});

console.log(`dropped-paths: ${passed} checks passed`);
