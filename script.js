// ==UserScript==
// @name         Classroom Merge (no login)
// @namespace    classroom-merge-nologin
// @version      1.0
// @description  Tick attachments on Classroom pages, merge them into one PDF in the order you ticked them. Uses your existing Google login, no OAuth.
// @match        https://classroom.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      google.com
// @connect      googleusercontent.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js
// ==/UserScript==

(() => {
  'use strict';
  const FILE_RE = /(?:drive\.google\.com\/file|docs\.google\.com\/(presentation|document))\/d\/([\w-]{10,})/;
  const sel = [];  // selected files, in click order: {id, kind, name}
  const info = {}; // id -> {id, kind, name}

  const authuser = () => (location.pathname.match(/\/u\/(\d+)/) || [0, 0])[1];
  const isPdf = (buf) => new TextDecoder().decode(buf.slice(0, 5)) === '%PDF-';

  const get = (url) => new Promise((res, rej) => GM_xmlhttpRequest({
    url,
    responseType: 'arraybuffer',
    onload: (r) => (r.status < 300 ? res(r.response) : rej(new Error('HTTP ' + r.status))),
    onerror: () => rej(new Error('network error')),
  }));

  async function getPdf({ id, kind }) {
    const q = 'authuser=' + authuser();
    const slides = `https://docs.google.com/presentation/d/${id}/export/pdf?${q}`;
    const doc = `https://docs.google.com/document/d/${id}/export?format=pdf&${q}`;
    const first = kind === 'presentation' ? slides
      : kind === 'document' ? doc
      : `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t&${q}`;
    let buf = await get(first);
    if (isPdf(buf)) return buf;
    if (kind) throw new Error('did not return a PDF; wrong Google account?');
    // An Office file stored in Drive (PPTX/DOCX): try Google's own converter
    for (const u of [slides, doc]) {
      try { buf = await get(u); if (isPdf(buf)) return buf; } catch { /* try next */ }
    }
    throw new Error('Office file could not be converted without OAuth');
  }

  // ---- panel (shadow DOM) ----
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      *{box-sizing:border-box;font:14px system-ui,sans-serif}
      #p{position:fixed;right:16px;bottom:16px;z-index:99999;width:300px;background:#fff;color:#202124;border:1px solid #ccc;border-radius:8px;padding:10px;box-shadow:0 4px 16px #0004}
      ol{margin:6px 0;padding-left:22px;max-height:200px;overflow:auto}
      li{margin:2px 0} li span{cursor:pointer;color:#c00;margin-left:6px}
      button{padding:6px 12px;margin-right:6px;cursor:pointer}
      #st{margin-top:6px;color:#555;word-break:break-word}
    </style>
    <div id=p hidden>
      <b id=n></b>
      <ol id=l></ol>
      <button id=go>Merge &amp; download</button><button id=clr>Clear</button>
      <div id=st></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const status = (t) => ($('#st').textContent = t);

  function render() {
    $('#p').hidden = !sel.length && !$('#st').textContent;
    $('#n').textContent = `${sel.length} selected (merge order)`;
    $('#l').innerHTML = '';
    sel.forEach((f, i) => {
      const li = document.createElement('li');
      li.textContent = f.name;
      const x = document.createElement('span');
      x.textContent = '×';
      x.onclick = () => { sel.splice(i, 1); render(); };
      li.append(x);
      $('#l').append(li);
    });
    for (const b of document.querySelectorAll('.cm-badge')) {
      const i = sel.findIndex((s) => s.id === b.dataset.id);
      b.textContent = i < 0 ? '' : i + 1;
      b.style.background = i < 0 ? '#fff' : '#1a73e8';
      b.style.color = '#fff';
    }
  }

  $('#clr').onclick = () => { sel.length = 0; status(''); render(); };
  $('#go').onclick = async () => {
    if (!sel.length) return;
    $('#go').disabled = true;
    const pdfs = [], failed = [];
    for (const [i, f] of sel.entries()) {
      status(`Fetching ${i + 1}/${sel.length}: ${f.name}`);
      try { pdfs.push(await getPdf(f)); } catch (e) { failed.push(`${f.name} (${e.message})`); }
    }
    if (pdfs.length) {
      status('Merging…');
      const out = await PDFLib.PDFDocument.create();
      for (const buf of pdfs) {
        const d = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
        (await out.copyPages(d, d.getPageIndices())).forEach((p) => out.addPage(p));
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([await out.save()], { type: 'application/pdf' }));
      a.download = 'merged.pdf';
      a.click();
    }
    status((pdfs.length ? `Merged ${pdfs.length} file(s).` : 'Nothing merged.') + (failed.length ? ' Skipped: ' + failed.join('; ') : ''));
    $('#go').disabled = false;
  };

  // ---- add a tick badge to every Drive/Docs attachment link on the page ----
  function scan() {
    for (const a of document.querySelectorAll('a[href]:not([data-cm])')) {
      let m;
      try { m = decodeURIComponent(a.href).match(FILE_RE); } catch { continue; }
      if (!m) continue;
      a.dataset.cm = '1';
      const id = m[2], kind = m[1] || '';
      const name = ((a.getAttribute('aria-label') || a.innerText || '').trim().split('\n')[0]) || id;
      info[id] = info[id] || { id, kind, name };
      const b = document.createElement('span');
      b.className = 'cm-badge';
      b.dataset.id = id;
      b.style.cssText = 'position:absolute;top:4px;right:4px;z-index:5;width:24px;height:24px;border-radius:50%;' +
        'border:2px solid #1a73e8;background:#fff;color:#fff;font:bold 12px system-ui;display:flex;' +
        'align-items:center;justify-content:center;cursor:pointer';
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      a.append(b);
    }
    render();
  }

  // capture on window so Classroom's own click handlers never see it
  window.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.cm-badge');
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const i = sel.findIndex((s) => s.id === b.dataset.id);
    if (i < 0) sel.push(info[b.dataset.id]); else sel.splice(i, 1);
    render();
  }, true);

  const start = () => {
    document.body.append(host);
    let t;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(scan, 400); })
      .observe(document.body, { childList: true, subtree: true });
    scan();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();