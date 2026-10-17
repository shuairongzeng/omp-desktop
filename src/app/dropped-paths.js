// dropped-paths.js — pure helpers for files/folders arriving from the OS:
// dropped onto the composer (Tauri's `tauri://drag-drop` event carries full
// paths) or pasted after a file-manager copy (`copied_file_paths` IPC).
//
// Everything that is not a decodable image becomes text: the path itself is
// inserted into the draft, and the agent reads it with its own tools. Only
// images keep the byte-attachment pipeline.
//
// No DOM/Tauri access; wrapped as an IIFE per the project rule (AGENTS.md).

(function () {
  // Extensions the webview can decode into an <img> (what the attachment
  // pipeline needs). Anything else — known or not — is a text path.
  const IMAGE_MIME = {
    png: "image/png",
    apng: "image/apng",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    avif: "image/avif",
  };

  // Last path segment in its original spelling (either separator style).
  function baseName(path) {
    const parts = (path || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
  }

  // Split dropped/copied paths into attachable images and text paths.
  // `[{ path, name, mime }]` for images, `[path]` for the rest, input order
  // kept. A folder's "extension" is just part of its name, so a directory
  // named `assets.png` would classify as an image — the read command then
  // refuses it ("not a file") and the composer falls back to inserting its
  // path, so the misclassification is self-healing.
  function splitDroppedPaths(paths) {
    const images = [];
    const others = [];
    for (const p of paths || []) {
      if (typeof p !== "string" || !p) continue;
      const ext = /\.([A-Za-z0-9]+)$/.exec(baseName(p))?.[1]?.toLowerCase();
      const mime = ext && IMAGE_MIME[ext];
      if (mime) images.push({ path: p, name: baseName(p), mime });
      else others.push(p);
    }
    return { images, others };
  }

  // One path as prompt text: double-quoted when it contains whitespace or a
  // quote, so `C:\My Files\a b.txt` survives being read back as one path.
  function quotePath(path) {
    return /[\s"]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
  }

  // The text to splice into `text` at `[start, end)` (the current
  // selection) for `paths`: space-separated quoted paths, a leading pad
  // only when preceded by a non-space, and always a trailing space, so the
  // insert never glues onto neighbouring words. Returns the splice
  // arguments for `OMP_MENTIONS.applyMention`.
  function pathsInsertText(text, start, end, paths) {
    const items = (paths || []).filter(p => typeof p === "string" && p);
    if (!items.length) return null;
    let insert = items.map(quotePath).join(" ");
    if (start > 0 && !/\s/.test(text[start - 1])) insert = " " + insert;
    if (end >= text.length || !/\s/.test(text[end])) insert += " ";
    return { range: { start, end }, insert };
  }

  window.OMP_DROPPED = { IMAGE_MIME, baseName, splitDroppedPaths, quotePath, pathsInsertText };
})();
