/**
 * app.js — UI + ZIP generation for the wpress-to-zip static app.
 * Everything runs locally: the .wpress file is read via Blob.slice(),
 * entries are added to JSZip as Blobs, and the resulting .zip is offered
 * as a download. Nothing is uploaded or stored server-side.
 */
'use strict';

(function () {
  var PREVIEW_ROWS = 100;
  // Already-compressed formats: recompressing wastes CPU for ~0 gain.
  var STORE_RE = /\.(jpe?g|png|gif|webp|avif|ico|mp4|m4v|mov|webm|mp3|ogg|wav|flac|zip|gz|tgz|bz2|7z|xz|rar|pdf|woff2?|ttf|otf|eot)$/i;

  var els = {};
  ['dropzone', 'fileInput', 'browseBtn', 'fileCard', 'fileName', 'fileSize',
   'archiveMeta', 'packageMeta', 'filterInput', 'previewTable', 'previewBody',
   'previewNote', 'optionsCard', 'outputName', 'compression', 'storeMedia',
   'convertBtn', 'resetBtn', 'progressCard', 'progressBar', 'progressLabel',
   'progressDetail', 'resultCard', 'resultMeta', 'downloadBtn', 'againBtn',
   'errorCard', 'errorMsg'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  var state = {
    file: null,
    entries: null,
    contentBytes: 0,
    pkg: null,
    zipUrl: null,
    working: false,
  };

  function formatBytes(n) {
    if (!isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = n / 1024;
    var u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[u];
  }

  function formatDate(mtime) {
    if (!mtime) return '—';
    return new Date(mtime * 1000).toLocaleString();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  function showError(msg) {
    els.errorMsg.textContent = msg;
    show(els.errorCard);
    els.errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function clearError() { hide(els.errorCard); els.errorMsg.textContent = ''; }

  function setProgress(pct, label, detail) {
    pct = Math.max(0, Math.min(100, pct));
    els.progressBar.style.width = pct.toFixed(1) + '%';
    els.progressBar.setAttribute('aria-valuenow', pct.toFixed(0));
    els.progressLabel.textContent = label;
    els.progressDetail.textContent = detail || '';
  }

  function setWorking(on) {
    state.working = on;
    els.convertBtn.disabled = on;
    els.browseBtn.disabled = on;
    els.fileInput.disabled = on;
    els.resetBtn.disabled = on;
  }

  // ---------- file selection ----------

  ['dragenter', 'dragover'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      els.dropzone.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    els.dropzone.addEventListener(evt, function (e) {
      e.preventDefault();
      els.dropzone.classList.remove('drag');
    });
  });
  els.dropzone.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  els.browseBtn.addEventListener('click', function () { els.fileInput.click(); });
  els.fileInput.addEventListener('change', function () {
    if (els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });
  els.resetBtn.addEventListener('click', resetAll);
  els.againBtn.addEventListener('click', resetAll);
  els.filterInput.addEventListener('input', renderPreview);

  function resetAll() {
    if (state.zipUrl) { URL.revokeObjectURL(state.zipUrl); state.zipUrl = null; }
    state.file = null;
    state.entries = null;
    state.pkg = null;
    hide(els.fileCard);
    hide(els.optionsCard);
    hide(els.progressCard);
    hide(els.resultCard);
    clearError();
    setProgress(0, '', '');
  }

  async function handleFile(file) {
    if (state.working) return;
    resetAll();
    clearError();

    if (!/\.wpress$/i.test(file.name)) {
      showError('"' + file.name + '" does not end in .wpress. Continuing anyway — if it is not an All-in-One WP Migration backup, scanning will fail.');
    }

    state.file = file;
    els.fileName.textContent = file.name;
    els.fileSize.textContent = formatBytes(file.size);
    els.archiveMeta.textContent = 'Scanning…';
    els.packageMeta.textContent = '';
    show(els.fileCard);
    show(els.progressCard);
    setProgress(2, 'Scanning archive…', 'Reading file headers locally');
    setWorking(true);

    try {
      var res = await window.Wpress.scan(file, function (p) {
        var pct = 2 + (p.bytesScanned / Math.max(1, p.totalBytes)) * 28; // scan = 2–30%
        setProgress(pct, 'Scanning archive…', p.files.toLocaleString() + ' files found');
      });
      state.entries = res.entries;
      state.contentBytes = res.contentBytes;

      if (!res.entries.length) throw new Error('No files found — this does not look like a .wpress archive.');

      var pkg = null;
      try { pkg = await window.Wpress.readPackageJson(file, res.entries); } catch (e) { /* ignore */ }
      state.pkg = pkg;

      var blocker = window.Wpress.supportBlocker(pkg);
      if (blocker) throw new Error(blocker);

      var pkgLine = pkg
        ? 'Site: ' + (pkg.SiteURL || pkg.HomeURL || 'unknown') +
          ' · WordPress ' + ((pkg.WordPress && pkg.WordPress.Version) || '?') +
          ' · DB prefix "' + ((pkg.Database && pkg.Database.Prefix) || '?') + '"'
        : 'package.json not found — continuing without site info.';
      els.packageMeta.textContent = pkgLine;
      els.archiveMeta.textContent =
        res.entries.length.toLocaleString() + ' files · ' +
        formatBytes(res.contentBytes) + ' content in ' + formatBytes(file.size) + ' archive';

      els.outputName.value = file.name.replace(/\.wpress$/i, '') + '.zip';
      renderPreview();
      show(els.optionsCard);
      hide(els.progressCard);
    } catch (err) {
      console.error(err);
      hide(els.progressCard);
      showError(err && err.message ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  // ---------- preview ----------

  function renderPreview() {
    if (!state.entries) return;
    var q = (els.filterInput.value || '').toLowerCase();
    var rows = [];
    var matched = 0;
    for (var i = 0; i < state.entries.length && rows.length < PREVIEW_ROWS; i++) {
      var e = state.entries[i];
      if (q && e.name.toLowerCase().indexOf(q) === -1) continue;
      matched++;
      rows.push('<tr><td>' + escapeHtml(e.name) + '</td>' +
        '<td class="num">' + formatBytes(e.size) + '</td>' +
        '<td class="num">' + escapeHtml(formatDate(e.mtime)) + '</td></tr>');
    }
    els.previewBody.innerHTML = rows.join('') ||
      '<tr><td colspan="3" class="muted">No files match this filter.</td></tr>';
    var total = state.entries.length.toLocaleString();
    els.previewNote.textContent = q
      ? 'Showing up to ' + PREVIEW_ROWS + ' matches (filter active, ' + total + ' files total).'
      : 'Showing first ' + Math.min(PREVIEW_ROWS, state.entries.length) + ' of ' + total + ' files. Use the filter to search.';
  }

  // ---------- conversion ----------

  els.convertBtn.addEventListener('click', async function () {
    if (state.working || !state.file || !state.entries) return;
    if (typeof JSZip === 'undefined') {
      showError('ZIP library (JSZip) failed to load. Check your connection and reload — the CDN script is required.');
      return;
    }
    clearError();
    hide(els.resultCard);
    show(els.progressCard);
    setWorking(true);
    var t0 = performance.now();

    try {
      var level = parseInt(els.compression.value, 10);
      var storeMedia = els.storeMedia.checked;
      var zip = new JSZip();
      var n = state.entries.length;

      for (var i = 0; i < n; i++) {
        var e = state.entries[i];
        var blob = window.Wpress.entryBlob(state.file, e);
        var useStore = (level === 0) || (storeMedia && STORE_RE.test(e.name));
        zip.file(e.name, blob, {
          date: e.mtime ? new Date(e.mtime * 1000) : new Date(),
          compression: useStore ? 'STORE' : 'DEFLATE',
          compressionOptions: useStore ? null : { level: level },
        });
        if (i % 200 === 0 || i === n - 1) {
          var pct = 30 + (i / n) * 40; // staging = 30–70%
          setProgress(pct, 'Preparing files…', (i + 1).toLocaleString() + ' / ' + n.toLocaleString());
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }

      var zipBlob = await zip.generateAsync(
        {
          type: 'blob',
          compression: level === 0 ? 'STORE' : 'DEFLATE',
          compressionOptions: { level: level },
          streamFiles: true,
        },
        function (meta) {
          var pct = 70 + (meta.percent || 0) * 0.3; // compress = 70–100%
          setProgress(pct, 'Compressing…', (meta.percent || 0).toFixed(1) + '% · ' + (meta.currentFile || ''));
        }
      );

      if (state.zipUrl) URL.revokeObjectURL(state.zipUrl);
      state.zipUrl = URL.createObjectURL(zipBlob);
      var outName = (els.outputName.value || 'archive.zip').trim() || 'archive.zip';
      if (!/\.zip$/i.test(outName)) outName += '.zip';

      var secs = (performance.now() - t0) / 1000;
      els.downloadBtn.href = state.zipUrl;
      els.downloadBtn.download = outName;
      els.resultMeta.textContent =
        n.toLocaleString() + ' files · ZIP ' + formatBytes(zipBlob.size) +
        ' (from ' + formatBytes(state.file.size) + ') · ' +
        secs.toFixed(1) + 's in your browser, nothing uploaded.';
      hide(els.progressCard);
      show(els.resultCard);
      els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      console.error(err);
      hide(els.progressCard);
      showError('Conversion failed: ' + (err && err.message ? err.message : err));
    } finally {
      setWorking(false);
    }
  });

  window.addEventListener('beforeunload', function () {
    if (state.zipUrl) URL.revokeObjectURL(state.zipUrl);
  });
})();
