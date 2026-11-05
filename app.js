// WhatScribe: page logic.
const $ = (id) => document.getElementById(id);
const SHARE_CACHE = 'shared-audio';
const SHARE_KEY = 'shared-audio-file';

// ---------- settings ----------
const DEFAULTS = {
  engine: 'local',
  localModel: 'onnx-community/whisper-small',
  remoteUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
  remoteModel: 'whisper-large-v3-turbo',
  lang: 'it',
  keepAudio: true,
};
function loadSettings() {
  try { const o = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') || '{}') }; delete o.remoteKey; return o; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {}
}
let settings = loadSettings();

// ---------- remote engine API key ----------
// The key never goes into localStorage: it is encrypted (AES-GCM) with a non-exportable
// browser key and stored in a separate IndexedDB database. It protects against dumps and copies
// of the site data; it does not protect against a malicious script loaded in the page (hence the CSP).
const keyVault = (() => {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('trascrivi-vault', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('v');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const get = async (k) => { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('v').objectStore('v').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); };
  const put = async (k, v) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('v', 'readwrite'); t.objectStore('v').put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
  const del = async (k) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('v', 'readwrite'); t.objectStore('v').delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); }); };
  async function cryptoKey() {
    let k = await get('ck');
    if (!k) {
      k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await put('ck', k);
    }
    return k;
  }
  return {
    async has() { return !!(await this.get()); },
    async set(text) {
      if (!text) { await del('blob'); return; }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(text));
      await put('blob', { iv, data });
    },
    async get() {
      const b = await get('blob');
      if (!b) return '';
      try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.iv }, await cryptoKey(), b.data)); }
      catch { return ''; }
    },
  };
})();

function bindSettings() {
  const map = {
    engine: 'engine', 'local-model': 'localModel', 'remote-url': 'remoteUrl',
    'remote-model': 'remoteModel', lang: 'lang',
  };
  for (const [id, key] of Object.entries(map)) {
    $(id).value = settings[key];
    $(id).addEventListener('change', () => { settings[key] = $(id).value.trim(); saveSettings(); syncEngineUi(); });
  }
  bindRemoteKey();
  $('keep-audio').checked = settings.keepAudio;
  $('keep-audio').addEventListener('change', () => { settings.keepAudio = $('keep-audio').checked; saveSettings(); });
  syncEngineUi();
}
async function bindRemoteKey() {
  // Migration: a key stored in the old settings is moved here, encrypted.
  try {
    const old = JSON.parse(localStorage.getItem('settings') || '{}');
    if (old.remoteKey) {
      try { await keyVault.set(old.remoteKey); }
      finally { delete old.remoteKey; localStorage.setItem('settings', JSON.stringify(old)); }
    }
  } catch {}
  const input = $('remote-key');
  const showSaved = async () => {
    const has = await keyVault.has();
    input.value = '';
    input.placeholder = has ? 'Chiave salvata (cifrata). Scrivi per sostituirla' : 'Incolla la tua chiave';
  };
  input.addEventListener('change', async () => {
    const v = input.value.trim();
    if (v) await keyVault.set(v);
    await showSaved();
  });
  $('btn-key-clear').addEventListener('click', async () => { await keyVault.set(''); await showSaved(); });
  showSaved();
}
function syncEngineUi() {
  $('local-opts').hidden = settings.engine !== 'local';
  $('remote-opts').hidden = settings.engine !== 'remote';
}

// ---------- IndexedDB history ----------
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('trascrivi', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbOp(mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const tx = db.transaction('items', mode);
    const out = fn(tx.objectStore('items'));
    tx.oncomplete = () => res(out && out.result);
    tx.onerror = () => rej(tx.error);
  });
}
const dbAdd = (item) => dbOp('readwrite', (s) => s.add(item));
const dbGet = (id) => dbOp('readonly', (s) => s.get(id));
const dbPut = (item) => dbOp('readwrite', (s) => s.put(item));
const dbAll = () => dbOp('readonly', (s) => s.getAll());
const dbDel = (id) => dbOp('readwrite', (s) => s.delete(id));
const dbClear = () => dbOp('readwrite', (s) => s.clear());

// ---------- UI status ----------
function setStatus(text, isErr = false) {
  $('status').textContent = text || '';
  $('status').classList.toggle('err', isErr);
}
function setProgress(frac, bar = $('bar')) {
  if (frac == null) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  bar.firstElementChild.style.width = Math.round(frac * 100) + '%';
}
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const fmtDate = (t) => new Date(t).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- audio ----------
async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    let data = audio.getChannelData(0);
    if (audio.numberOfChannels > 1) {
      const b = audio.getChannelData(1);
      const mono = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) mono[i] = (data[i] + b[i]) / 2;
      data = mono;
    }
    return { samples: data, duration: audio.duration };
  } finally {
    ctx.close();
  }
}

// ---------- engines ----------
let worker = null;
const mainUi = { status: (t) => setStatus(t), progress: (f) => setProgress(f) };

// Runs a command on the worker (transcription or model download only) and reports status and progress to the given UI.
async function runWorker(msg, ui = mainUi, transfer = []) {
  if (!worker) worker = new Worker('worker.js', { type: 'module' });
  const files = {};
  // The library also reports progress when it reads files from the local cache: don't call that a download.
  const fromCache = msg.model ? await isModelCached(msg.model) : false;
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'status') ui.status(data.text);
      else if (data.type === 'progress') {
        files[data.file] = [data.loaded, data.total];
        const v = Object.values(files);
        const loaded = v.reduce((a, x) => a + x[0], 0), total = v.reduce((a, x) => a + x[1], 0);
        ui.progress(total ? loaded / total : null);
        ui.status(`${fromCache ? 'Carico il modello' : 'Scarico il modello'}… ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
      } else if (data.type === 'device') { ui.progress(null); }
      else if (data.type === 'done') { ui.progress(null); resolve(data.text); }
      else if (data.type === 'ready') { ui.progress(null); resolve(); }
      else if (data.type === 'error') { ui.progress(null); reject(new Error(data.text)); }
    };
    worker.onerror = (e) => { ui.progress(null); worker = null; reject(new Error(e.message || 'Non riesco a caricare il motore locale: al primo uso serve la connessione per scaricarlo.')); };
    worker.postMessage(msg, transfer);
  });
}
const transcribeLocal = (samples) =>
  runWorker({ audio: samples, model: settings.localModel, language: settings.lang }, mainUi, [samples.buffer]);

// ---------- local model: download from settings ----------
async function isModelCached(model) {
  try {
    if (!('caches' in window) || !(await caches.has('transformers-cache'))) return false;
    const keys = await (await caches.open('transformers-cache')).keys();
    return keys.some((r) => r.url.includes(`/${model}/resolve/`));
  } catch { return false; }
}

async function refreshModelState() {
  if (busy) return;
  const ok = await isModelCached(settings.localModel);
  $('model-state').textContent = ok ? 'Scaricato, pronto anche offline' : 'Non ancora scaricato';
  $('btn-model').textContent = ok ? 'Verifica' : 'Scarica modello';
}

async function downloadModel() {
  if (busy) { $('model-state').textContent = 'Un’altra operazione è in corso.'; return; }
  busy = true;
  $('btn-model').disabled = true;
  const bar = $('model-bar');
  const ui = {
    status: (t) => { $('model-state').textContent = t; $('model-state').classList.remove('err'); },
    progress: (f) => setProgress(f, bar),
  };
  try {
    await runWorker({ preload: true, model: settings.localModel }, ui);
    busy = false;
    await refreshModelState();
  } catch (err) {
    console.error(err);
    $('model-state').textContent = err.message || String(err);
    $('model-state').classList.add('err');
  } finally {
    busy = false;
    $('btn-model').disabled = false;
  }
}

async function transcribeRemote(blob, name) {
  const remoteKey = await keyVault.get();
  if (!settings.remoteUrl || !remoteKey) throw new Error('Imposta endpoint e API key nelle impostazioni.');
  setStatus('Invio al server…');
  const fd = new FormData();
  // OpenAI-compatible endpoints accept .ogg but not .opus as an extension
  const fname = (name || 'vocale').replace(/\.(opus|oga)$/i, '') + (/\.(ogg|mp3|m4a|wav|webm|mp4|flac)$/i.test(name || '') ? '' : '.ogg');
  fd.append('file', new File([blob], fname, { type: blob.type || 'audio/ogg' }));
  fd.append('model', settings.remoteModel || 'whisper-large-v3-turbo');
  fd.append('language', settings.lang);
  fd.append('response_format', 'json');
  const r = await fetch(settings.remoteUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${remoteKey}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`Server: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.text || '').trim();
}

// ---------- main flow ----------
let current = null; // { blob, name, id }
let busy = false;

// Transcribes an audio file. Without an id it is saved to recents first, so it stays available even if transcription fails.
async function process(blob, name, id) {
  showView('home');
  if (busy) { setStatus('Un’altra trascrizione è in corso.', true); return; }
  busy = true;
  document.body.classList.add('working');
  $('current').hidden = false;
  $('intro').hidden = true;
  $('cur-text').hidden = true;
  $('cur-actions').hidden = true;
  $('btn-copy').hidden = $('btn-share').hidden = false;
  $('cur-audio').src = URL.createObjectURL(blob);
  $('cur-meta').textContent = name || 'vocale';
  setStatus('Decodifico l’audio…');
  try {
    if (id == null) id = await dbAdd({ date: Date.now(), name, duration: null, text: null, engine: null, audio: blob });
    current = { blob, name, id };
    renderRecent();
    const { samples, duration } = await decodeTo16k(blob);
    $('cur-meta').textContent = `${name || 'vocale'} · ${fmtDur(duration)}`;
    const t0 = performance.now();
    const text = settings.engine === 'remote'
      ? await transcribeRemote(blob, name)
      : await transcribeLocal(samples);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatus(`Fatto in ${secs} s`);
    $('cur-text').textContent = text || '(nessun parlato riconosciuto)';
    $('cur-text').hidden = false;
    $('cur-actions').hidden = false;
    const prev = (await dbGet(id)) || { id, date: Date.now(), name };
    await dbPut({
      ...prev, duration, text,
      engine: settings.engine === 'remote' ? settings.remoteModel : settings.localModel.split('/').pop(),
      audio: settings.keepAudio ? blob : null,
    });
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
    $('cur-actions').hidden = false;
    $('btn-copy').hidden = $('btn-share').hidden = true;
  } finally {
    busy = false;
    document.body.classList.remove('working');
    renderRecent();
  }
}

async function readSharedFile() {
  if (!('caches' in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const resp = await cache.match(SHARE_KEY);
  if (!resp) return null;
  const blob = await resp.blob();
  let name = 'vocale.ogg';
  try { name = decodeURIComponent(resp.headers.get('x-file-name') || name); } catch {}
  await cache.delete(SHARE_KEY);
  return { blob, name };
}

// ---------- lists ----------
const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

// Compact row (date, duration, first line of text) that expands to show the full text, audio and actions.
function itemCard(it, mode) {
  const card = document.createElement('div');
  card.className = 'card item';

  const rowEl = document.createElement('div');
  rowEl.className = 'item-row';
  const toggle = document.createElement('button');
  toggle.className = 'item-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  const txt = document.createElement('span');
  txt.className = 'item-txt';
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  meta.textContent = [fmtDate(it.date), fmtDur(it.duration), it.text != null && it.engine].filter(Boolean).join(' · ');
  const line = document.createElement('span');
  line.className = 'item-line' + (it.text == null ? ' pending' : '');
  line.textContent = it.text == null ? 'Da trascrivere' : (it.text || '(nessun parlato riconosciuto)');
  txt.append(meta, line);
  toggle.append(txt);
  toggle.insertAdjacentHTML('beforeend', CHEV);
  rowEl.append(toggle);

  const body = document.createElement('div');
  body.className = 'item-body';
  body.inert = true;
  const inner = document.createElement('div');
  inner.className = 'item-inner';
  body.append(inner);

  if (it.text != null) {
    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = it.text;
    inner.append(text);
  }
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.style.marginTop = '10px';
  const btn = (label, fn, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = () => fn(b);
    return b;
  };
  if (mode === 'recent') {
    if (it.audio) actions.append(btn(it.text != null ? 'Rifai' : 'Trascrivi', () => process(it.audio, it.name, it.id), it.text == null));
    if (it.text) actions.append(btn('Copia', (b) => copyText(it.text, b), true));
  } else {
    actions.append(btn('Copia', (b) => copyText(it.text, b), true));
  }
  actions.append(btn('Elimina', async () => { await dbDel(it.id); renderRecent(); renderHistory(); }));
  inner.append(actions);

  // shortcut: a voice note not yet transcribed can be started straight from its row
  if (mode === 'recent' && it.text == null && it.audio) {
    const quick = btn('Trascrivi', () => process(it.audio, it.name, it.id), true);
    quick.classList.add('mini');
    rowEl.append(quick);
  }

  toggle.onclick = () => {
    const open = !card.classList.contains('open');
    if (open && it.audio && !inner.querySelector('audio')) {
      const a = document.createElement('audio');
      a.controls = true; a.preload = 'none'; a.src = URL.createObjectURL(it.audio);
      inner.insertBefore(a, actions);
    }
    card.classList.toggle('open', open);
    body.inert = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  card.append(rowEl, body);
  return card;
}

function fillList(box, items, emptyText, mode) {
  for (const a of box.querySelectorAll('audio')) URL.revokeObjectURL(a.src);
  box.innerHTML = '';
  if (!items.length) { box.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
  items.forEach((it, i) => {
    const c = itemCard(it, mode);
    if (!box.dataset.seen) { c.classList.add('enter'); c.style.setProperty('--i', i); }
    box.append(c);
  });
  box.dataset.seen = '1';
}

async function renderRecent() {
  const items = (await dbAll()).sort((a, b) => b.date - a.date).slice(0, 5);
  $('recent-wrap').hidden = !items.length;
  $('intro').hidden = items.length > 0 || !$('current').hidden;
  fillList($('recent'), items, '', 'recent');
}

async function renderHistory() {
  const items = (await dbAll()).filter((it) => it.text != null).sort((a, b) => b.date - a.date);
  fillList($('history'), items, 'Ancora nessuna trascrizione.', 'history');
}

// ---------- views and menu ----------
function showView(v) {
  const cur = ['home', 'settings', 'history'].find((n) => !$('view-' + n).hidden);
  if (cur === v) { closeMenu(); return; }
  const swap = async () => {
    for (const n of ['home', 'settings', 'history']) $('view-' + n).hidden = n !== v;
    closeMenu();
    delete $('recent').dataset.seen; delete $('history').dataset.seen;
    if (v === 'history') await renderHistory();
    if (v === 'home') await renderRecent();
    if (v === 'settings') refreshModelState();
    window.scrollTo(0, 0);
  };
  if (cur && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.dataset.dir = v === 'home' ? 'back' : 'forward';
    document.startViewTransition(swap);
  } else swap();
}
function openView(v) { history.pushState({ v }, ''); showView(v); }
function closeMenu() {
  const m = $('menu');
  $('btn-menu').setAttribute('aria-expanded', 'false');
  if (m.hidden || m.classList.contains('closing')) return;
  m.classList.add('closing');
  setTimeout(() => { m.hidden = true; m.classList.remove('closing'); }, 160);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent; btn.textContent = 'Copiato'; setTimeout(() => (btn.textContent = old), 1200);
  } catch { /* clipboard unavailable */ }
}

// ---------- startup ----------
bindSettings();
renderRecent();

$('file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) process(f, f.name);
  e.target.value = '';
});
$('btn-copy').onclick = () => copyText($('cur-text').textContent, $('btn-copy'));
$('btn-share').onclick = () => {
  const text = $('cur-text').textContent;
  if (navigator.share) navigator.share({ text }).catch(() => {});
  else copyText(text, $('btn-share'));
};
$('btn-retry').onclick = () => current && process(current.blob, current.name, current.id);
$('btn-model').onclick = downloadModel;
$('local-model').addEventListener('change', refreshModelState);
$('btn-clear').onclick = async () => {
  if (!confirm('Svuotare tutto lo storico e i vocali salvati?')) return;
  await dbClear(); renderRecent(); renderHistory();
};
$('btn-menu').onclick = (e) => {
  e.stopPropagation();
  if (!$('menu').hidden && !$('menu').classList.contains('closing')) { closeMenu(); return; }
  $('menu').classList.remove('closing');
  $('menu').hidden = false;
  $('btn-menu').setAttribute('aria-expanded', 'true');
};
$('menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) openView(b.dataset.view);
});
document.addEventListener('click', closeMenu);
for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => history.back();
window.addEventListener('popstate', (e) => showView((e.state && e.state.v) || 'home'));

// ---------- install button ----------
// Chrome fires beforeinstallprompt only when it decides the app is installable (and not always);
// keep the event and offer our own button, which stays hidden when the app is already installed.
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('btn-install').hidden = false;
});
$('btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  const ev = installEvent;
  installEvent = null;
  $('btn-install').hidden = true;
  try { await ev.prompt(); } catch {}
});
window.addEventListener('appinstalled', () => { installEvent = null; $('btn-install').hidden = true; });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW non registrato', e));
}

const params = new URLSearchParams(location.search);
if (params.has('shared')) {
  history.replaceState(null, '', location.pathname);
  if (params.get('shared') === 'error') {
    $('intro').hidden = true; $('current').hidden = false;
    setStatus('Non ho ricevuto nessun file audio dalla condivisione.', true);
  } else {
    readSharedFile().then((f) => {
      if (f) process(f.blob, f.name);
      else { $('intro').hidden = true; $('current').hidden = false; setStatus('File condiviso non trovato.', true); }
    }).catch(() => { $('intro').hidden = true; $('current').hidden = false; setStatus('Non riesco a leggere il file condiviso.', true); });
  }
}
