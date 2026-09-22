/**
 * wpress.js — minimal All-in-One WP Migration (.wpress) archive reader.
 *
 * Runs 100% in the browser. The file is never uploaded anywhere; we only
 * read slices of the user-selected File via Blob.slice().
 *
 * Format (see Ai1wm_Archiver, HEADER_SIZE = 4377):
 *   name    0    255   basename, NUL-padded   (raw bytes, usually UTF-8)
 *   size  255     14   decimal file size
 *   mtime 269     12   decimal unix mtime
 *   path  281   4088   dirname with "/" separators, "." for root
 *   crc32 4369     8   hex crc32b of ORIGINAL content (may be empty)
 *
 * Each header is followed by exactly `size` bytes of file data.
 * Archives end with one EOF block: all NULs (v1) or an empty name/path
 * with a hex8 crc (v2, also stores the pre-EOF archive size in `size`).
 *
 * NOTE: Pro archives with chunk compression (gzip/bzip2) or encryption
 * store transformed chunks and need secrets from package.json. This reader
 * handles plain (free) archives and refuses compressed/encrypted ones.
 */
'use strict';

(function (global) {
  var HEADER_SIZE = 4377;
  var OFF_NAME = 0;
  var LEN_NAME = 255;
  var OFF_SIZE = 255;
  var LEN_SIZE = 14;
  var OFF_MTIME = 269;
  var LEN_MTIME = 12;
  var OFF_PATH = 281;
  var LEN_PATH = 4088;
  var OFF_CRC = 4369;
  var LEN_CRC = 8;

  var asciiDecoder = new TextDecoder('windows-1252');
  var utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  var HEX8 = /^[0-9a-f]{8}$/i;

  function cleanField(bytes, offset, length, useUtf8) {
    var end = offset + length;
    // Strip NUL padding (PHP pack 'a'), then whitespace (PHP trim()).
    while (end > offset && bytes[end - 1] === 0) end--;
    var text = (useUtf8 ? utf8Decoder : asciiDecoder).decode(
      bytes.subarray(offset, end)
    );
    return text.replace(/^[\s\0]+|[\s\0]+$/g, '');
  }

  function parseHeader(bytes) {
    return {
      name: cleanField(bytes, OFF_NAME, LEN_NAME, true),
      size: cleanField(bytes, OFF_SIZE, LEN_SIZE, false),
      mtime: cleanField(bytes, OFF_MTIME, LEN_MTIME, false),
      path: cleanField(bytes, OFF_PATH, LEN_PATH, true),
      crc: cleanField(bytes, OFF_CRC, LEN_CRC, false),
    };
  }

  function isV1Eof(h) {
    return h.name === '' && h.size === '' && h.mtime === '' && h.path === '' && h.crc === '';
  }

  function isV2Eof(h) {
    return h.name === '' && h.path === '' && HEX8.test(h.crc);
  }

  function normalizeName(path, name) {
    if (!path || path === '.') return name;
    return path.replace(/\\/g, '/') + '/' + name;
  }

  function isUnsafeName(name) {
    if (!name || name.charAt(0) === '/' || name.charAt(0) === '\\') return true;
    if (/^[A-Za-z]:/.test(name)) return true; // Windows absolute
    var parts = name.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') return true;
    }
    return false;
  }

  function yieldToUI() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  /**
   * Scan a .wpress File/Blob without loading contents into memory.
   * onProgress({ files, bytesScanned, totalBytes }) is called periodically.
   * Resolves to { entries, contentBytes } where each entry is
   * { name, size, mtime, crc, dataOffset }.
   */
  async function scan(file, onProgress) {
    var entries = [];
    var offset = 0;
    var total = file.size;
    var contentBytes = 0;
    var lastYield = 0;

    while (offset + HEADER_SIZE <= total) {
      var buf = await file.slice(offset, offset + HEADER_SIZE).arrayBuffer();
      var bytes = new Uint8Array(buf);
      var h = parseHeader(bytes);

      if (isV1Eof(h) || isV2Eof(h)) break;

      var size = parseInt(h.size, 10);
      var mtime = parseInt(h.mtime, 10);
      if (isNaN(size) || size < 0) {
        throw new Error('Corrupt archive: bad size for "' + (h.name || '?') + '" at offset ' + offset + '.');
      }
      if (offset + HEADER_SIZE + size > total) {
        throw new Error('Corrupt archive: "' + h.name + '" claims ' + size + ' bytes past end of file.');
      }

      var fullName = normalizeName(h.path, h.name);
      if (!fullName) {
        throw new Error('Corrupt archive: empty filename at offset ' + offset + '.');
      }
      if (isUnsafeName(fullName)) {
        throw new Error('Blocked unsafe path in archive: "' + fullName + '".');
      }

      entries.push({
        name: fullName,
        size: size,
        mtime: isNaN(mtime) || mtime <= 0 ? 0 : mtime,
        crc: h.crc,
        dataOffset: offset + HEADER_SIZE,
      });
      contentBytes += size;
      offset += HEADER_SIZE + size;

      if (onProgress && (entries.length % 250 === 0 || offset >= total)) {
        onProgress({ files: entries.length, bytesScanned: offset, totalBytes: total });
      }
      // Keep the tab responsive on 10k+ file archives.
      if (entries.length - lastYield >= 1000) {
        lastYield = entries.length;
        await yieldToUI();
      }
      if (entries.length > 500000) {
        throw new Error('Archive has an implausible file count; refusing to continue.');
      }
    }

    return { entries: entries, contentBytes: contentBytes };
  }

  /**
   * Read one entry's content as a Blob (zero-copy slice of the .wpress file).
   */
  function entryBlob(file, entry, mimeType) {
    return file.slice(entry.dataOffset, entry.dataOffset + entry.size, mimeType || 'application/octet-stream');
  }

  /**
   * Find + parse package.json from a scan result. Returns null when absent.
   */
  async function readPackageJson(file, entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].name === 'package.json') {
        var text = await entryBlob(file, entries[i], 'application/json').text();
        return JSON.parse(text);
      }
    }
    return null;
  }

  /**
   * Pro archives need server-side secrets/handling; fail fast with a reason.
   * Returns null when the archive looks like a plain (convertible) one.
   */
  function supportBlocker(pkg) {
    if (!pkg) return null;
    if (pkg.Compression && (pkg.Compression.Enabled === true || pkg.Compression.Type)) {
      return 'This backup uses All-in-One WP Migration Pro compression (' +
        (pkg.Compression.Type || 'unknown') +
        '). Chunked/compressed archives cannot be converted in the browser. Export without compression or restore on a WordPress site instead.';
    }
    if (pkg.EncryptedSignature || pkg.Encrypted === true) {
      return 'This backup is password-encrypted. Encrypted archives cannot be converted in the browser. Restore it on a WordPress site with the password instead.';
    }
    return null;
  }

  global.Wpress = {
    HEADER_SIZE: HEADER_SIZE,
    scan: scan,
    entryBlob: entryBlob,
    readPackageJson: readPackageJson,
    supportBlocker: supportBlocker,
    parseHeader: parseHeader,
  };
})(typeof window !== 'undefined' ? window : this);
