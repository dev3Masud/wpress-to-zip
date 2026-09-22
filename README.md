# wpress-to-zip

Convert **All-in-One WP Migration (`.wpress`)** backups to **`.zip`** — entirely in the
browser. No uploads, no accounts, no server storage. Drop the folder on Netlify and it works.

## Privacy model

- The `.wpress` file is read with `Blob.slice()`; only small header slices are ever
  decoded. File contents go straight from the original bytes into the ZIP writer.
- The finished ZIP is exposed as a temporary `blob:` URL in the tab. Reloading or
  converting another file revokes it. Nothing is sent anywhere — after first load
  the app makes zero network requests (JSZip is vendored locally).

## Use

1. Open the site, drop a `.wpress` file (or choose one).
2. Check the detected site info + file preview.
3. Pick an output name and compression level, hit **Convert to ZIP**, download.

## Deploy to Netlify

Any of these works — no build settings needed (`publish = .`, no build command):

**A. Drag & drop (fastest):** open <https://app.netlify.com/drop>, drag this folder
(`index.html`, `styles.css`, `wpress.js`, `app.js`, `jszip.min.js`, `netlify.toml`) onto it.

**B. Netlify CLI:**
`npm i -g netlify-cli`, then from this folder: `netlify deploy --dir=. --prod`.

**C. Git:** push this folder's repo to GitHub/GitLab, then Netlify
*Add new site → Import an existing project* with publish directory `.` and empty build command.

## Local preview

Any static server works, e.g. `npx serve .` or VS Code Live Server, then open the page.
(`file://` also works, but some browsers restrict CDN scripts there — prefer a server.)

## Format notes

`.wpress` = repeated 4,377-byte headers
(`a255` name / `a14` size / `a12` mtime / `a4088` path / `a8` crc32) each followed by
`size` raw bytes, ending in an all-NUL (v1) or empty-name+hex-CRC (v2) EOF block.
This matches `Ai1wm_Archiver::HEADER_SIZE` / `Ai1wm_Extractor` in
All-in-One WP Migration 7.x.

## Limitations

- Plain (free-version) archives only. Backups using Pro chunk compression
  (`package.json → Compression.Enabled`) or password encryption
  (`EncryptedSignature`) are detected and refused with an explanation.
- Big sites need RAM ~3–4× the backup size while compressing; use a desktop browser.
- Filenames with `..`, absolute paths, or drive letters are rejected (same as the plugin).
