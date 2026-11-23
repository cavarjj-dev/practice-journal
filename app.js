/* Active Imagination Practice Journal
   Everything stays on this device: IndexedDB for sessions and audio. No network calls. */
'use strict';
const APP_VERSION = '3 (Nov 23, 2026)';

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDur = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000)); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
const fmtMin = (ms) => { const m = Math.round((ms || 0) / 60000); return m < 1 ? '<1 min' : m + ' min'; };
const fmtSize = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200); }
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const extFor = (mime) => /mp4|aac|m4a/.test(mime || '') ? 'm4a' : /ogg/.test(mime || '') ? 'ogg' : /wav/.test(mime || '') ? 'wav' : 'webm';
const stamp = (t) => { const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

// ---------- IndexedDB ----------
let dbPromise;
function db() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open('practice-journal', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('recordings', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode); let out;
    const req = fn(t.objectStore(store)); if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('Storage aborted'));
  });
}
const dbPut = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
const dbGet = (s, k) => tx(s, 'readonly', (o) => o.get(k));
const dbAll = (s) => tx(s, 'readonly', (o) => o.getAll());
const dbDel = (s, k) => tx(s, 'readwrite', (o) => o.delete(k));
const recsFor = (sessionId) => tx('recordings', 'readonly', (o) => o.index('sessionId').getAll(sessionId));
async function metaGet(key, dflt) { const r = await dbGet('meta', key); return r ? r.value : dflt; }
const metaSet = (key, value) => dbPut('meta', { key, value });
async function allSessions() { const a = await dbAll('sessions'); return a.sort((x, y) => y.createdAt - x.createdAt); }
async function deleteSession(id) {
  const recs = await recsFor(id);
  for (const r of recs) await dbDel('recordings', r.id);
  await dbDel('sessions', id);
}

// ---------- content drawn from the guide ----------
const SUGGESTIONS = [
  { t: 'Two voices: spirit of this time / spirit of the depths', s: 'Prologue, “The Way of What Is to Come” — warm-up, no figure', p: '' },
  { t: 'Refinding the Soul', s: 'Liber Primus, ch. I — the guide’s first arc', p: 'My soul, where are you? Do you hear me?' },
  { t: 'Soul and God', s: 'Liber Primus, ch. II', p: '' },
  { t: 'On the Service of the Soul', s: 'Liber Primus, ch. III', p: '' },
  { t: 'The Desert', s: 'Liber Primus, ch. IV — for barren or stuck periods', p: '' },
  { t: 'Mysterium. Encounter: the house, the serpent, the blind maiden', s: 'Liber Primus, ch. IX — later phase', p: 'Who are you? What do you want?' },
  { t: 'An illuminated page (choose by pull)', s: 'Facsimile: look 3 minutes, pick one element', p: '' },
  { t: 'A mood or emotion', s: 'Sink into it; find the image that expresses it', p: '' },
  { t: 'A dream image or remembered scene', s: '“Start with any image.”', p: '' },
];
const PROMPTS = [
  'I see ___. I’m staying with it. What happens next?',
  'Who are you? What do you want?',
  'My soul, where are you? Do you hear me?',
];
const ARC_FOCUS = (n) => n <= 1 ? 'Session 1 of an arc: establish the image; observe only. No dialogue yet unless a figure speaks first.'
  : n === 2 ? 'Session 2: re-enter at the last scene and let it move. Start where you stopped, not from the beginning.'
  : n <= 4 ? `Session ${n}: dialogue — who are you, what do you want. Record verbatim; no interpretation.`
  : n === 5 ? 'Session 5: confrontation — state your position and your disagreement. Equal rights.'
  : n === 6 ? 'Session 6: a good point for the weekly review (Step 7 questions; one ethical action).'
  : `Session ${n}: continue until the image resolves, transforms, or goes quiet for 2–3 sessions. Then close the arc in writing.`;
const MOOD_LABELS = ['Very low', 'Low', 'Even', 'Good', 'Very good'];
const TENSION_LABELS = ['Loose', 'Mild', 'Some', 'Tight', 'Very tight'];
const STOP_SIGNALS = ['Heart racing / panic', 'Image felt literally real', 'Combat memory / flashback', 'Numb, “not here”', 'Urge to self-harm', 'Figure demanded action in outer life'];
const URGENT_SIGNALS = new Set(['Urge to self-harm']);
const STEPS = [
  { key: 'arrive', label: 'Arrive' },
  { key: 'before', label: 'Check in' },
  { key: 'ground', label: 'Ground in' },
  { key: 'start', label: 'Starting point' },
  { key: 'dialogue', label: 'Dialogue' },
  { key: 'close', label: 'Close' },
  { key: 'after', label: 'Check out' },
  { key: 'done', label: 'Saved' },
];

// ---------- state ----------
const S = { view: 'home', session: null, detailId: null, urls: [], rec: null, timers: {}, editing: false };
function clearTimers() { Object.values(S.timers).forEach((t) => clearInterval(t)); S.timers = {}; }
function revokeUrls() { S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls = []; }
let saveTimer;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 400); }
async function saveSession() { clearTimeout(saveTimer); if (S.session) { S.session.updatedAt = Date.now(); await dbPut('sessions', S.session); } }

// ---------- recorder ----------
function pickMime() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  for (const m of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ }
  }
  return '';
}
class Recorder {
  constructor(phase, onChange) { this.phase = phase; this.onChange = onChange; this.state = 'idle'; this.acc = 0; this.seg = 0; this.chunks = []; this.wake = null; }
  elapsed() { return this.acc + (this.state === 'recording' ? performance.now() - this.seg : 0); }
  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) throw new Error('This browser can’t record audio here. Use Safari on iPhone or Chrome on desktop, over https.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = pickMime();
    this.mr = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mime = this.mr.mimeType || mime;
    this.chunks = [];
    this.mr.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.stream.getAudioTracks().forEach((t) => t.addEventListener('ended', () => { if (this.state !== 'idle') this.finish(true); }));
    this.mr.start(1000);
    this.state = 'recording'; this.acc = 0; this.seg = performance.now();
    try { if (navigator.wakeLock) this.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
    this.onChange();
  }
  pause() { if (this.state !== 'recording') return; this.mr.pause(); this.acc += performance.now() - this.seg; this.state = 'paused'; this.onChange(); }
  resume() { if (this.state !== 'paused') return; this.mr.resume(); this.seg = performance.now(); this.state = 'recording'; this.onChange(); }
  stop() {
    if (this.state === 'idle') return Promise.resolve(null);
    return new Promise((resolve) => {
      const durationMs = this.elapsed();
      this.state = 'stopping';
      this.mr.onstop = () => {
        const type = this.mime || (this.chunks[0] && this.chunks[0].type) || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        resolve({ blob, durationMs, mime: type });
      };
      try { this.mr.stop(); } catch (e) { this.cleanup(); resolve(null); }
    });
  }
  async finish(interrupted) {
    const r = await this.stop();
    if (r) await saveClip(this.phase, r);
    if (interrupted) toast('Recording stopped by the device. What was captured is saved.');
    this.onChange(true);
  }
  cleanup() {
    this.state = 'idle';
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.wake) { try { this.wake.release(); } catch (e) { /* */ } this.wake = null; }
  }
}
async function saveClip(phase, r) {
  if (!r || !r.blob || !r.blob.size || !S.session) return;
  const data = await r.blob.arrayBuffer();
  const meta = { id: uid(), sessionId: S.session.id, phase, mime: r.mime, durationMs: Math.round(r.durationMs), size: data.byteLength, createdAt: Date.now() };
  await dbPut('recordings', Object.assign({ data }, meta));
  S.session.clips = (S.session.clips || []).concat(meta);
  await saveSession();
}
async function stopActiveRecording() {
  if (S.rec && S.rec.state !== 'idle') { const rec = S.rec; const r = await rec.stop(); if (r) await saveClip(rec.phase, r); }
  S.rec = null;
}

function recorderBlock(phase, title) {
  return `<div class="card recorder" data-recorder="${phase}">
    <div class="steplabel">${esc(title)}</div>
    <button class="recbtn" data-action="rec-main" aria-label="Record">Record</button>
    <div class="recstate" data-recstate>Tap to record. Audio stays on this device.</div>
    <div class="row hidden" data-recctl>
      <button class="btn ghost" data-action="rec-stop">Stop &amp; save</button>
    </div>
    <ul class="clips" data-clips></ul>
  </div>`;
}
function updateRecorderUI(root) {
  const box = root || $('[data-recorder]'); if (!box) return;
  const rec = S.rec && S.rec.phase === box.dataset.recorder ? S.rec : null;
  const st = rec ? rec.state : 'idle';
  const btn = $('[data-action="rec-main"]', box), lab = $('[data-recstate]', box), ctl = $('[data-recctl]', box);
  btn.classList.toggle('recording', st === 'recording'); btn.classList.toggle('paused', st === 'paused');
  btn.textContent = st === 'recording' ? 'Pause' : st === 'paused' ? 'Resume' : 'Record';
  btn.setAttribute('aria-label', btn.textContent);
  ctl.classList.toggle('hidden', st === 'idle');
  lab.textContent = st === 'recording' ? '● Recording ' + fmtDur(rec.elapsed()) : st === 'paused' ? 'Paused at ' + fmtDur(rec.elapsed()) : 'Tap to record. Audio stays on this device.';
}
async function renderClips(phase, editable) {
  const box = $(`[data-recorder="${phase}"] [data-clips]`) || $(`[data-clips="${phase}"]`); if (!box) return;
  const metas = (S.session.clips || []).filter((c) => c.phase === phase);
  if (!metas.length) { box.innerHTML = ''; return; }
  const recs = await recsFor(S.session.id);
  const byId = new Map(recs.map((r) => [r.id, r]));
  box.innerHTML = metas.map((m, i) => {
    const r = byId.get(m.id); let src = '';
    if (r && r.data) { src = URL.createObjectURL(new Blob([r.data], { type: r.mime })); S.urls.push(src); }
    return `<li><div class="cliphead"><span>${phase === 'reflection' ? 'Reflection' : 'Dialogue'} clip ${i + 1} · ${fmtDur(m.durationMs)} · ${fmtSize(m.size)}</span>
      <span><button class="linkbtn" data-action="clip-dl" data-id="${m.id}">Download</button>${editable ? `<button class="linkbtn" data-action="clip-del" data-id="${m.id}">Delete</button>` : ''}</span></div>
      ${src ? `<audio controls preload="metadata" src="${src}"></audio>` : '<span class="muted small">Audio missing</span>'}</li>`;
  }).join('');
}
function bindRecorder(phase) {
  const box = $(`[data-recorder="${phase}"]`); if (!box) return;
  updateRecorderUI(box);
  renderClips(phase, true);
  clearInterval(S.timers.rec);
  S.timers.rec = setInterval(() => updateRecorderUI(box), 500);
}
async function recAction(action, phase) {
  try {
    if (action === 'rec-main') {
      if (!S.rec || S.rec.state === 'idle') {
        S.rec = new Recorder(phase, (done) => { updateRecorderUI(); if (done) renderClips(phase, true); });
        await S.rec.start();
      } else if (S.rec.state === 'recording') S.rec.pause();
      else if (S.rec.state === 'paused') S.rec.resume();
    } else if (action === 'rec-pause') {
      if (S.rec && S.rec.state === 'recording') S.rec.pause(); else if (S.rec) S.rec.resume();
    } else if (action === 'rec-stop') {
      if (S.rec) { const rec = S.rec; const r = await rec.stop(); updateRecorderUI(); if (r) { await saveClip(phase, r); toast('Recording saved on this device.'); } renderClips(phase, true); }
    }
  } catch (e) {
    if (S.rec) S.rec.cleanup();
    S.rec = null; updateRecorderUI();
    toast(e && e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser settings to record.' : (e.message || 'Could not record.'));
  }
}

// ---------- shared UI pieces ----------
function scale(name, value, labels) {
  return `<div class="scale" role="group" data-scale="${name}">${labels.map((l, i) => `<button type="button" data-v="${i + 1}" aria-pressed="${value === i + 1}"><strong>${i + 1}</strong><span>${esc(l)}</span></button>`).join('')}</div>`;
}
function progress(i) { return `<div class="progress" aria-hidden="true">${STEPS.slice(0, -1).map((_, k) => `<span class="${k <= i ? 'done' : ''}"></span>`).join('')}</div>`; }
function setNav(view) { $$('.tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.nav === view || ((view === 'session' || view === 'guided') && b.dataset.nav === 'home') || (view === 'detail' && b.dataset.nav === 'history') ? 'page' : 'false')); }

// ---------- stats ----------
function weekKey(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function computeStats(sessions) {
  const done = sessions.filter((s) => s.status === 'complete').sort((a, b) => a.createdAt - b.createdAt);
  const weeks = new Set(done.map((s) => weekKey(s.createdAt)));
  const thisWeek = weekKey(Date.now());
  const WEEK = 7 * 864e5;
  let streak = 0; let w = weeks.has(thisWeek) ? thisWeek : thisWeek - WEEK;
  while (weeks.has(w) || weeks.has(weekKey(w + 3 * 864e5))) { streak++; w = weekKey(w - 3 * 864e5); }
  const withMood = done.filter((s) => s.before && s.after && s.before.mood && s.after.mood);
  const last = withMood.slice(-10);
  const avg = last.length ? last.reduce((a, s) => a + (s.after.mood - s.before.mood), 0) / last.length : null;
  const perWeek = [];
  for (let k = 7; k >= 0; k--) { const wk = weekKey(thisWeek - k * WEEK + 3 * 864e5); perWeek.push({ wk, n: done.filter((s) => weekKey(s.createdAt) === wk).length }); }
  return { total: done.length, thisWeek: done.filter((s) => weekKey(s.createdAt) === thisWeek).length, streak, avg, chart: withMood.slice(-20), perWeek };
}
function moodChart(points) {
  if (points.length < 1) return '<p class="muted small">The mood chart appears after your first session with before and after check-ins.</p>';
  const W = 340, H = 170, L = 26, R = 10, T = 12, B = 22, iw = W - L - R, ih = H - T - B;
  const x = (i) => L + (points.length === 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v) => T + ((5 - v) / 4) * ih;
  let g = '';
  for (let v = 1; v <= 5; v++) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="currentColor" stroke-opacity=".12"/><text x="${L - 8}" y="${y(v) + 4}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity=".55">${v}</text>`;
  points.forEach((s, i) => { g += `<line x1="${x(i)}" x2="${x(i)}" y1="${y(s.before.mood)}" y2="${y(s.after.mood)}" stroke="var(--muted)" stroke-opacity=".5" stroke-width="2"/>`; });
  const path = points.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.after.mood).toFixed(1)}`).join(' ');
  g += `<path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-opacity=".7"/>`;
  points.forEach((s, i) => {
    g += `<circle cx="${x(i)}" cy="${y(s.before.mood)}" r="4" fill="var(--calm)"><title>${esc(fmtDate(s.createdAt))}: before ${s.before.mood}</title></circle>`;
    g += `<circle cx="${x(i)}" cy="${y(s.after.mood)}" r="5" fill="var(--accent)"><title>${esc(fmtDate(s.createdAt))}: after ${s.after.mood}</title></circle>`;
  });
  const first = points[0], lastp = points[points.length - 1];
  g += `<text x="${L}" y="${H - 6}" font-size="10" fill="currentColor" fill-opacity=".55">${esc(new Date(first.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
  if (points.length > 1) g += `<text x="${W - R}" y="${H - 6}" font-size="10" text-anchor="end" fill="currentColor" fill-opacity=".55">${esc(new Date(lastp.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mood before and after, last ${points.length} sessions">${g}</svg>
  <div class="legend"><span><i class="lg-before"></i>Mood before</span><span><i class="lg-after"></i>Mood after</span><span>1 = very low · 5 = very good</span></div>`;
}
function weekBars(perWeek) {
  const W = 340, H = 90, L = 6, B = 18, max = Math.max(4, ...perWeek.map((p) => p.n)); const bw = (W - L * 2) / perWeek.length;
  let g = '';
  perWeek.forEach((p, i) => {
    const h = ((H - B - 14) * p.n) / max; const x = L + i * bw + 4;
    g += `<rect x="${x}" y="${H - B - h}" width="${bw - 8}" height="${Math.max(h, 1)}" rx="4" fill="var(--accent)" fill-opacity="${p.n ? 0.75 : 0.2}"/>`;
    if (p.n) g += `<text x="${x + (bw - 8) / 2}" y="${H - B - h - 4}" font-size="10" text-anchor="middle" fill="currentColor" fill-opacity=".7">${p.n}</text>`;
    g += `<text x="${x + (bw - 8) / 2}" y="${H - 5}" font-size="9" text-anchor="middle" fill="currentColor" fill-opacity=".5">${esc(new Date(p.wk).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sessions per week, last 8 weeks">${g}</svg>`;
}
function statsBlock(st) {
  const avg = st.avg == null ? '—' : (st.avg > 0 ? '+' : '') + st.avg.toFixed(1);
  return `<div class="stats">
    <div class="stat"><b data-stat="total">${st.total}</b><span>sessions</span></div>
    <div class="stat"><b>${st.thisWeek}</b><span>this week</span></div>
    <div class="stat"><b>${st.streak}</b><span>week streak</span></div>
  </div>
  <div class="card chart"><div class="steplabel">Mood change · avg ${avg} (last 10)</div>${moodChart(st.chart)}</div>
  <div class="card chart"><div class="steplabel">Sessions per week</div>${weekBars(st.perWeek)}</div>`;
}

// ---------- views ----------
async function render() {
  clearTimers(); revokeUrls();
  setNav(S.view);
  const app = $('#app');
  if (S.view === 'home') app.innerHTML = await viewHome();
  else if (S.view === 'session') app.innerHTML = await viewStep();
  else if (S.view === 'history') app.innerHTML = await viewHistory();
  else if (S.view === 'detail') app.innerHTML = await viewDetail();
  else if (S.view === 'reflect') app.innerHTML = viewReflect();
  else if (S.view === 'backup') app.innerHTML = await viewBackup();
  else if (S.view === 'guided') app.innerHTML = Guided.view();
  else if (S.view === 'settings') app.innerHTML = await Guided.settingsView();
  afterRender();
  window.scrollTo(0, 0);
}
function afterRender() {
  if (S.view === 'session') {
    const k = STEPS[S.session.step].key;
    if (k !== 'done') bindRecorder('dialogue');
    if (k === 'dialogue') startDialogueClock();
    if (k === 'ground') bindGround();
  }
  if (S.view === 'reflect') bindRecorder('reflection');
  if (S.view === 'detail') { renderClips('dialogue', true); renderClips('reflection', true); }
  if (S.view === 'backup') fillStorage();
  if (S.view === 'guided') Guided.after();
}

async function viewHome() {
  const sessions = await allSessions();
  const open = sessions.find((s) => s.status === 'in-progress');
  const done = sessions.filter((s) => s.status === 'complete');
  const closed = new Set(await metaGet('closedArcs', []));
  const latest = done[0];
  const lastBackup = await metaGet('lastBackup', 0);
  const st = computeStats(sessions);
  let h = `<h1>${esc(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</h1>`;
  if (open) {
    h += `<div class="card"><div class="steplabel">Unfinished session</div><p>${esc(open.image || 'No image chosen yet')} · started ${esc(fmtDate(open.createdAt))} ${esc(fmtTime(open.createdAt))}</p>
      <div class="row"><button class="btn" data-action="resume" data-id="${open.id}">Resume</button><button class="btn ghost" data-action="finish-open" data-id="${open.id}">Save as is</button></div></div>`;
  }
  h += `<div class="card stack">
    <button class="btn block big" data-action="guided">🎙 Guided session: talk it through</button>
    <p class="muted small">It asks each question out loud, listens, writes your answers into the template, and asks a follow-up when something’s missing.</p>
    <button class="btn ghost block" data-action="new">Session on my own (with audio recording)</button>`;
  if (latest && !closed.has(latest.arcId || latest.id)) {
    const n = done.filter((s) => (s.arcId || s.id) === (latest.arcId || latest.id)).length + 1;
    h += `<div class="row"><button class="btn quiet" data-action="guided-continue" data-id="${latest.id}">Continue “${esc(latest.image)}” · session ${n} (guided)</button><button class="btn ghost" data-action="continue" data-id="${latest.id}">On my own</button></div>`;
  }
  h += `<p class="muted small">3–4 days a week at your sharpest time, never within 2 hours of sleep. 20 minutes for weeks 1–4, up to 30 after.</p></div>`;
  if (done.length && (!lastBackup || Date.now() - lastBackup > 7 * 864e5)) {
    h += `<div class="note warn">Your recordings live only in this browser. ${lastBackup ? 'Last backup ' + esc(fmtDate(lastBackup)) + '.' : 'No backup yet.'} <button class="linkbtn" data-nav="backup">Back up now</button></div>`;
  }
  h += statsBlock(st);
  return h;
}

async function viewStep() {
  const s = S.session, i = s.step, k = STEPS[i].key;
  let h = progress(i) + (k !== 'done' ? recorderBlock('dialogue', 'Audio recording · stays on this device · keeps running across steps') : '') + `<div class="steplabel">Step ${Math.min(i + 1, 7)} of 7 · ${esc(STEPS[i].label)}</div>`;
  const nav = (next = 'Next', back = true, extra = '') => `<div class="navrow">${back ? '<button class="btn ghost" data-action="back">Back</button>' : ''}${extra}<button class="btn" data-action="next">${next}</button></div>`;
  if (k === 'arrive') {
    const anchors = await metaGet('anchors', ['', '', '']);
    h += `<h1>Arrive</h1><p>Phone on silent. Water nearby. Notebook, the Red Book, and colored pencils if you like.</p>
      <div class="card"><div class="steplabel">Read your 3 anchors aloud</div>
      ${[0, 1, 2].map((n) => `<input type="text" data-anchor="${n}" value="${esc(anchors[n] || '')}" placeholder="Anchor ${n + 1}" aria-label="Anchor ${n + 1}">`).join('<div class="spacer6"></div>')}
      <p class="muted small">Saved on this device for next time.</p></div>` + nav('I’ve arrived', false, '<button class="btn ghost" data-action="cancel">Cancel</button>');
  } else if (k === 'before' || k === 'after') {
    const c = s[k] || {};
    h += `<h1>${k === 'before' ? 'Before you begin' : 'Check out'}</h1>
      <label class="field">Mood</label>${scale('mood', c.mood, MOOD_LABELS)}
      <label class="field">Body tension</label>${scale('tension', c.tension, TENSION_LABELS)}
      <label class="field" for="cnote">A word or note (optional)</label><input type="text" id="cnote" data-field="${k}.note" value="${esc(c.note || '')}" placeholder="${k === 'before' ? 'e.g. restless, clear, tired' : 'e.g. settled, stirred up'}">
      <div class="note warn ${k === 'before' && c.tension >= 4 ? '' : 'hidden'}" data-tension-note>Tension is high. Your template says: do the grounding routine and don’t start today.
        <div class="row mt8"><button class="btn quiet" data-action="ground-stop">Ground and stop for today</button></div></div>`;
    if (k === 'after') {
      const sig = new Set(s.stopSignals || []);
      h += `<label class="field">Stop signals today?</label><div class="chips">
        <button class="chip" data-signal="none" aria-pressed="${!!s.noSignals}">None</button>
        ${STOP_SIGNALS.map((x) => `<button class="chip" data-signal="${esc(x)}" aria-pressed="${sig.has(x)}">${esc(x)}</button>`).join('')}</div>
        <div class="note ${[...sig].some((x) => URGENT_SIGNALS.has(x)) ? '' : 'hidden'}" data-urgent>Please reach out now: Veterans Crisis Line, <a href="tel:988">call 988 then press 1</a>, or <a href="sms:838255">text 838255</a>.</div>
        <div class="note ${sig.size && ![...sig].some((x) => URGENT_SIGNALS.has(x)) ? '' : 'hidden'}" data-signal-note>Noted. Skip the after-reflection today. If signals repeat, the guide suggests pausing 1–2 weeks and telling your therapist.</div>`;
    }
    h += nav(k === 'after' ? 'Save session' : 'Next');
  } else if (k === 'ground') {
    h += `<h1>Ground in</h1><p>Feet on the floor. Five slow breaths, out longer than in.</p>
      <div class="card"><div class="breath" data-breath aria-hidden="true">in 4 · out 6</div>
      <div class="timer" data-gtimer>2:00</div>
      <div class="row"><button class="btn quiet" data-action="gtoggle">Start timer</button></div></div>` + nav('Ready');
  } else if (k === 'start') {
    const arcPrev = s.arcId ? await lastInArc(s.arcId, s.id) : null;
    h += `<h1>Starting point</h1>`;
    if (arcPrev) {
      const lines = (arcPrev.dialogue || '').trim().split('\n').filter(Boolean).slice(-5).join('\n');
      h += `<div class="card"><div class="steplabel">Arc · session ${s.arcIndex}</div><p>${esc(ARC_FOCUS(s.arcIndex))}</p>
        ${lines ? `<div class="steplabel">Re-entry cue: last 5 lines</div><div class="pre">${esc(lines)}</div>` : '<p class="muted small">No typed lines from last time. Replay the last recording or recall the final scene.</p>'}</div>`;
    }
    h += `<label class="field" for="img">Image, mood, or passage</label>
      <input type="text" id="img" data-field="image" value="${esc(s.image || '')}" placeholder="What are you starting with?">
      <label class="field" for="src">Source or page (optional)</label>
      <input type="text" id="src" data-field="source" value="${esc(s.source || '')}" placeholder="e.g. Liber Primus ch. I, p. 232">`;
    if (!arcPrev) {
      h += `<label class="field">Suggestions from your guide</label><div class="chips">${SUGGESTIONS.map((x, n) => `<button class="chip" data-suggest="${n}"><span>${esc(x.t)}</span><small>${esc(x.s)}</small></button>`).join('')}</div>
      <p class="muted small">The guide suggests holding chapters V–VIII until you’ve practiced 6–8 weeks and a therapist knows about the work.</p>`;
    }
    h += `<label class="field">Starting prompt</label><div class="chips">${PROMPTS.map((p) => `<button class="chip" data-prompt="${esc(p)}" aria-pressed="${s.prompt === p}">${esc(p)}</button>`).join('')}</div>`;
    h += nav('Begin dialogue');
  } else if (k === 'dialogue') {
    h += `<h1>Dialogue</h1><p class="muted">${esc(s.image || '')}${s.prompt ? ' · “' + esc(s.prompt) + '”' : ''}</p>
      <div class="timer small-timer" data-dtimer>0:00</div><p class="muted small center" data-dhint>Hold the image. Wait for movement. Step in. Speak and listen. Don’t interpret.</p>
      <div class="card"><label class="field" for="verb">Verbatim notes (optional)</label>
      <div class="chips mb8"><button class="chip" data-insert="ME: ">ME:</button><button class="chip" data-insert="FIGURE: ">FIGURE:</button><button class="chip" data-insert="[scene] ">[scene]</button><button class="chip" data-insert="[ego steering] ">[ego steering]</button></div>
      <textarea id="verb" class="verbatim" data-field="dialogue" placeholder="ME: …&#10;FIGURE: …">${esc(s.dialogue || '')}</textarea></div>
      <div class="navrow"><button class="btn ghost" data-action="stop-now">Stop now</button><button class="btn" data-action="next">End dialogue</button></div>`;
  } else if (k === 'close') {
    const items = ['Eyes open. Feet flat. Press down for 10 seconds.', `Say it aloud: “Today is ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}. I am here. Next I am going to …”`, 'Stand, drink water, walk 2–5 minutes.', 'Close the notebook and the book. Put them away.'];
    h += `<h1>Close</h1>${s.stoppedEarly ? '<div class="note">You stopped early. That’s the practice working. Ground first; no after-reflection today.</div>' : ''}
      <p>Return to the actually existing, ordinary person.</p>
      <div class="card checklist">${items.map((t, n) => `<label><input type="checkbox" data-close="${n}" ${(s.closeChecks || [])[n] ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}</div>
      <p class="muted small">Then one ordinary physical task: dishes, an email, a call.</p>` + nav('Next', !s.stoppedEarly);
  } else if (k === 'done') {
    const dur = (s.endedAt || Date.now()) - (s.startedAt || s.createdAt);
    h += `<h1>Saved on this device</h1><div class="card"><p><strong>${esc(s.image || 'Session')}</strong></p>
      <p class="muted">${esc(fmtDate(s.createdAt))} · ${fmtMin(dur)} · mood ${s.before && s.before.mood || '—'} → ${s.after && s.after.mood || '—'}${(s.clips || []).length ? ' · ' + s.clips.length + ' recording' + (s.clips.length > 1 ? 's' : '') : ''}</p></div>`;
    if (!s.stoppedEarly && !(s.stopSignals || []).length) {
      h += `<div class="card"><div class="steplabel">After-reflection</div><p>Keep it separate, ideally an hour or more from now. You’ll find it under History.</p>
        <div class="row"><button class="btn quiet" data-action="reflect-now">Reflect now</button></div></div>`;
    }
    h += `<div class="navrow"><button class="btn" data-action="home">Done</button></div>`;
  }
  return h;
}
async function lastInArc(arcId, excludeId) {
  const all = (await allSessions()).filter((x) => (x.arcId || x.id) === arcId && x.id !== excludeId && x.status === 'complete');
  return all[0] || null;
}

async function viewHistory() {
  const sessions = await allSessions();
  if (!sessions.length) return '<h1>History</h1><div class="empty">No sessions yet. Your first one will show here.</div>';
  const arcCounts = {};
  sessions.slice().reverse().forEach((s) => { const a = s.arcId || s.id; arcCounts[a] = (arcCounts[a] || 0) + 1; s._arcN = arcCounts[a]; });
  let h = '<h1>History</h1>' + statsBlock(computeStats(sessions));
  h += sessions.map((s) => {
    const dur = (s.endedAt || s.updatedAt || s.createdAt) - (s.startedAt || s.createdAt);
    const arcTotal = arcCounts[s.arcId || s.id];
    return `<button class="session-item" data-action="open" data-id="${s.id}">
      <div class="t">${esc(s.image || 'No image chosen')}</div>
      <div class="m">${esc(fmtDate(s.createdAt))} · ${fmtMin(dur)} · mood ${s.before && s.before.mood || '—'} → ${s.after && s.after.mood || '—'}</div>
      <div class="m">${s.status !== 'complete' ? '<span class="pill warn">unfinished</span>' : ''}${arcTotal > 1 ? `<span class="pill">arc · ${s._arcN} of ${arcTotal}</span>` : ''}${(s.clips || []).length ? `<span class="pill">${s.clips.length} audio</span>` : ''}${s.reflection && s.reflection.at ? '<span class="pill">reflected</span>' : ''}${(s.stopSignals || []).length ? '<span class="pill warn">stop signal</span>' : ''}</div>
    </button>`;
  }).join('');
  return h;
}

async function viewDetail() {
  const s = await dbGet('sessions', S.detailId);
  if (!s) { S.view = 'history'; return viewHistory(); }
  S.session = s;
  const closed = new Set(await metaGet('closedArcs', []));
  const arcId = s.arcId || s.id;
  const dur = (s.endedAt || s.updatedAt || s.createdAt) - (s.startedAt || s.createdAt);
  const r = s.reflection || {};
  let h = `<button class="linkbtn" data-nav="history">← History</button>
    <h1>${esc(s.image || 'Session')}</h1>
    <p class="muted">${esc(fmtDate(s.createdAt))} ${esc(fmtTime(s.createdAt))} · ${fmtMin(dur)}${s.source ? ' · ' + esc(s.source) : ''}</p>
    ${s.prompt ? `<p>Prompt: “${esc(s.prompt)}”</p>` : ''}
    <div class="card"><div class="steplabel">Check-ins</div>
      <p>Before: mood ${s.before && s.before.mood || '—'}, tension ${s.before && s.before.tension || '—'}${s.before && s.before.note ? ' · ' + esc(s.before.note) : ''}</p>
      <p>After: mood ${s.after && s.after.mood || '—'}, tension ${s.after && s.after.tension || '—'}${s.after && s.after.note ? ' · ' + esc(s.after.note) : ''}</p>
      <p class="muted small">Stop signals: ${(s.stopSignals || []).length ? esc(s.stopSignals.join(', ')) : 'none noted'}${s.stoppedEarly ? ' · stopped early' : ''}</p></div>
    <div class="card"><div class="steplabel">Dialogue recordings</div><ul class="clips" data-clips="dialogue"></ul>${(s.clips || []).some((c) => c.phase === 'dialogue') ? '' : '<p class="muted small">None.</p>'}</div>
    <div class="card"><div class="steplabel">Verbatim notes</div>
      ${S.editing ? `<textarea class="verbatim" data-field="dialogue">${esc(s.dialogue || '')}</textarea><div class="row mt8"><button class="btn" data-action="save-edit">Save notes</button></div>`
        : `${s.dialogue ? `<div class="pre">${esc(s.dialogue)}</div>` : '<p class="muted small">No typed notes.</p>'}<button class="linkbtn" data-action="edit">Edit notes</button>`}</div>
    <div class="card"><div class="steplabel">After-reflection</div>
      ${r.at ? `<p class="muted small">${esc(fmtDate(r.at))}</p>
        ${r.affected ? `<p><strong>How am I affected?</strong><br>${esc(r.affected)}</p>` : ''}
        ${r.resisted ? `<p><strong>What did the figure want that I resisted?</strong><br>${esc(r.resisted)}</p>` : ''}
        ${r.action ? `<p><strong>One concrete action:</strong><br>${esc(r.action)}</p>` : ''}
        ${r.power ? `<p><strong>Power-principle check:</strong><br>${esc(r.power)}</p>` : ''}
        ${r.notes ? `<p><strong>Notes:</strong><br>${esc(r.notes)}</p>` : ''}` : '<p class="muted small">Not yet.</p>'}
      <ul class="clips" data-clips="reflection"></ul>
      <button class="btn quiet block" data-action="reflect">${r.at ? 'Edit reflection' : 'Add after-reflection'}</button></div>
    <div class="card stack">
      ${s.status === 'complete' ? `<button class="btn block" data-action="guided-continue" data-id="${s.id}">Continue this image (guided)</button><button class="btn ghost block" data-action="continue" data-id="${s.id}">Continue this image on my own</button>` : `<button class="btn block" data-action="resume" data-id="${s.id}">Resume this session</button>`}
      <button class="btn ghost block" data-action="arc-toggle" data-arc="${arcId}">${closed.has(arcId) ? 'Reopen this arc' : 'Close this arc'}</button>
      <button class="btn danger block" data-action="delete" data-id="${s.id}">Delete session</button>
    </div>`;
  return h;
}

function viewReflect() {
  const s = S.session, r = s.reflection || {};
  const recent = s.endedAt && Date.now() - s.endedAt < 3600e3;
  const q = [['affected', 'How am I affected by this?'], ['resisted', 'What did the figure want that I resisted?'], ['action', 'One concrete action this implies (by when)'], ['power', 'Power-principle check: how could I misuse this insight?']];
  return `<button class="linkbtn" data-action="back-detail">← Session</button><h1>After-reflection</h1>
    <p class="muted">${esc(s.image || '')} · ${esc(fmtDate(s.createdAt))}</p>
    ${recent ? '<p class="muted small">The guide suggests at least an hour after the session.</p>' : ''}
    <button class="btn block" data-action="guided-reflect">🎙 Talk it through (guided)</button>
    ${q.map(([k, l]) => `<label class="field" for="r-${k}">${esc(l)}</label><textarea id="r-${k}" data-field="reflection.${k}">${esc(r[k] || '')}</textarea>`).join('')}
    ${recorderBlock('reflection', 'Voice reflection (optional)')}
    <label class="field" for="r-notes">Other notes</label><textarea id="r-notes" data-field="reflection.notes">${esc(r.notes || '')}</textarea>
    <div class="navrow"><button class="btn" data-action="save-reflect">Save reflection</button></div>`;
}

async function viewBackup() {
  const lastBackup = await metaGet('lastBackup', 0);
  const n = (await allSessions()).length;
  return `<h1>Backup</h1>
    <div class="note warn"><strong>Recordings live only in this browser on this device.</strong> Clearing Safari or Chrome website data, deleting the home-screen app, or the browser freeing up space will delete them. Back up regularly.</div>
    <div class="card"><div class="steplabel">Storage</div><p data-storage>Checking…</p>
      <button class="btn quiet" data-action="persist">Ask the browser to keep this data</button></div>
    <div class="card stack"><div class="steplabel">Export · ${n} session${n === 1 ? '' : 's'}${lastBackup ? ' · last backup ' + esc(fmtDate(lastBackup)) : ''}</div>
      <button class="btn block" data-action="export-zip">Export everything (.zip with audio)</button>
      <button class="btn ghost block hidden" data-action="share-zip">Share / Save to Files…</button>
      <button class="btn ghost block" data-action="export-json">Export text only (.json)</button>
      <p class="muted small">The .zip holds journal.json plus one audio file per recording. Keep it somewhere private, such as iCloud Drive or a USB drive.</p></div>
    <div class="card"><div class="steplabel">Import</div>
      <p class="muted small">Restore from a .zip or .json exported here. Sessions you already have are skipped.</p>
      <label class="btn ghost block" for="importFile">Choose backup file</label>
      <input type="file" id="importFile" accept=".zip,.json,application/zip,application/json" class="hidden"></div>
    <div class="card"><div class="steplabel">Privacy</div><p class="small muted">No account, no server, no analytics, nothing loaded from other sites. Audio is never sent anywhere. The only outside connection the page allows is to the AI provider you pick in Settings, and only for the text of guided sessions.</p></div>
    <div class="card"><div class="steplabel">Updates</div><p class="small muted">Version ${APP_VERSION}. If you don’t see a new feature, close the Home Screen app completely (swipe it away in the app switcher) and open it again.</p></div>`;
}
async function fillStorage() {
  const el = $('[data-storage]'); if (!el) return;
  let txt = '';
  try {
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); txt += `Using about ${fmtSize(e.usage || 0)}. `; }
    if (navigator.storage && navigator.storage.persisted) txt += (await navigator.storage.persisted()) ? 'The browser has agreed to keep this data.' : 'The browser may clear this data under storage pressure or after long disuse.';
  } catch (e) { /* */ }
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone) txt += ' On iPhone, add this page to your Home Screen: Safari can delete data for sites not opened in 7 days, and the Home Screen app is protected from that.';
  el.textContent = txt || 'Storage details aren’t available in this browser.';
  if (navigator.canShare) { try { if (navigator.canShare({ files: [new File([new Uint8Array(1)], 't.zip', { type: 'application/zip' })] })) $('[data-action="share-zip"]').classList.remove('hidden'); } catch (e) { /* */ } }
}

// ---------- export / import ----------
async function buildExport(withAudio) {
  const sessions = await allSessions();
  const recs = withAudio ? await dbAll('recordings') : [];
  const anchors = await metaGet('anchors', ['', '', '']);
  const closedArcs = await metaGet('closedArcs', []);
  const files = [];
  const recMeta = recs.map((r) => {
    const s = sessions.find((x) => x.id === r.sessionId);
    const file = `audio/${stamp(s ? s.createdAt : r.createdAt)}_${r.phase}_${r.id}.${extFor(r.mime)}`;
    files.push({ name: file, data: new Uint8Array(r.data), date: new Date(r.createdAt) });
    return { id: r.id, sessionId: r.sessionId, phase: r.phase, mime: r.mime, durationMs: r.durationMs, size: r.size, createdAt: r.createdAt, file };
  });
  const journal = { app: 'active-imagination-practice-journal', version: 1, exportedAt: new Date().toISOString(), anchors, closedArcs, sessions, recordings: recMeta };
  return { journal, files };
}
async function exportZip(share) {
  toast('Preparing backup…');
  const { journal, files } = await buildExport(true);
  const json = new TextEncoder().encode(JSON.stringify(journal, null, 2));
  const readme = new TextEncoder().encode('Active Imagination Practice Journal backup\n\njournal.json holds all sessions, notes, check-ins and reflections.\naudio/ holds each recording (file names start with the session date).\nTo restore, open the app > Backup > Import and choose this .zip.\n');
  const blob = PJZip.makeZip([{ name: 'journal.json', data: json }, { name: 'README.txt', data: readme }, ...files]);
  const name = `practice-journal-backup_${stamp(Date.now())}.zip`;
  if (share && navigator.share) {
    try { await navigator.share({ files: [new File([blob], name, { type: 'application/zip' })], title: 'Practice journal backup' }); }
    catch (e) { if (e.name !== 'AbortError') toast('Sharing failed; try Export instead.'); return; }
  } else download(blob, name);
  await metaSet('lastBackup', Date.now());
  toast('Backup ready.');
}
async function exportJson() {
  const { journal } = await buildExport(false);
  download(new Blob([JSON.stringify(journal, null, 2)], { type: 'application/json' }), `practice-journal-text_${stamp(Date.now())}.json`);
}
async function importFile(file) {
  const buf = await file.arrayBuffer();
  let journal, entries = null;
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (head[0] === 0x50 && head[1] === 0x4b) {
    entries = PJZip.readZip(buf);
    const j = entries.get('journal.json'); if (!j) throw new Error('No journal.json in this zip.');
    journal = JSON.parse(new TextDecoder().decode(j));
  } else journal = JSON.parse(new TextDecoder().decode(buf));
  if (!journal || journal.app !== 'active-imagination-practice-journal' || !Array.isArray(journal.sessions)) throw new Error('This file isn’t a Practice Journal backup.');
  const existing = new Set((await dbAll('sessions')).map((s) => s.id));
  let added = 0, skipped = 0, audio = 0, missing = 0;
  for (const s of journal.sessions) {
    if (!s || !s.id) continue;
    if (existing.has(s.id)) { skipped++; continue; }
    const metas = (journal.recordings || []).filter((r) => r.sessionId === s.id);
    const keep = [];
    for (const m of metas) {
      const data = entries && entries.get(m.file);
      if (data) { await dbPut('recordings', { id: m.id, sessionId: m.sessionId, phase: m.phase, mime: m.mime, durationMs: m.durationMs, size: data.byteLength, createdAt: m.createdAt, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }); audio++; keep.push(m.id); }
      else missing++;
    }
    if (entries) s.clips = (s.clips || []).filter((c) => keep.includes(c.id));
    await dbPut('sessions', s); added++;
  }
  const anchors = await metaGet('anchors', ['', '', '']);
  if (!anchors.some(Boolean) && Array.isArray(journal.anchors)) await metaSet('anchors', journal.anchors);
  if (Array.isArray(journal.closedArcs)) await metaSet('closedArcs', Array.from(new Set([...(await metaGet('closedArcs', [])), ...journal.closedArcs])));
  return { added, skipped, audio, missing };
}

// ---------- session flow ----------
async function newSession(fromId) {
  const s = { id: uid(), status: 'in-progress', createdAt: Date.now(), startedAt: Date.now(), step: 0, before: {}, after: {}, clips: [], stopSignals: [], closeChecks: [] };
  if (fromId) {
    const prev = await dbGet('sessions', fromId);
    if (prev) {
      s.arcId = prev.arcId || prev.id; s.image = prev.image; s.source = prev.source; s.prompt = prev.prompt;
      const n = (await allSessions()).filter((x) => (x.arcId || x.id) === s.arcId && x.status === 'complete').length;
      s.arcIndex = n + 1;
      if (!prev.arcId) { prev.arcId = prev.id; await dbPut('sessions', prev); }
    }
  }
  S.session = s; await saveSession(); S.view = 'session'; render();
}
async function goStep(delta) {
  const s = S.session; const k = STEPS[s.step].key;
  if (delta > 0 && k === 'start' && !(s.image || '').trim()) { toast('Name the image, mood or passage first.'); $('#img') && $('#img').focus(); return; }
  if (k === 'dialogue') s.dialogueEndedAt = s.dialogueEndedAt || Date.now();
  if (delta > 0 && k === 'after') { await stopActiveRecording(); s.endedAt = Date.now(); s.status = 'complete'; }
  s.step = Math.max(0, Math.min(STEPS.length - 1, s.step + delta));
  if (STEPS[s.step].key === 'dialogue') { s.dialogueStartedAt = s.dialogueStartedAt || Date.now(); s.dialogueEndedAt = null; }
  await saveSession(); render();
}
function startDialogueClock() {
  const el = $('[data-dtimer]'), hint = $('[data-dhint]'); const s = S.session; let noted = false;
  const tick = () => { const ms = Date.now() - s.dialogueStartedAt; el.textContent = fmtDur(ms); if (!noted && ms > 20 * 60e3) { noted = true; hint.textContent = '20 minutes. A good place to close when the scene allows.'; } };
  tick(); S.timers.dlg = setInterval(tick, 1000);
}
function bindGround() {
  let left = 120, running = false, phase = 0;
  const el = $('[data-gtimer]'), br = $('[data-breath]'), btn = $('[data-action="gtoggle"]');
  const paint = () => { el.textContent = fmtDur(left * 1000); };
  S.groundToggle = () => {
    running = !running; btn.textContent = running ? 'Pause' : left < 120 ? 'Resume' : 'Start timer';
    clearInterval(S.timers.g); clearInterval(S.timers.b);
    if (!running) return;
    const breathe = () => { const inhale = phase % 2 === 0; br.className = 'breath ' + (inhale ? 'in' : 'out'); br.textContent = inhale ? 'in' : 'out'; phase++; clearInterval(S.timers.b); S.timers.b = setTimeout(breathe, inhale ? 4000 : 6000); };
    breathe();
    S.timers.g = setInterval(() => { left--; paint(); if (left <= 0) { clearInterval(S.timers.g); clearTimeout(S.timers.b); br.className = 'breath'; br.textContent = 'done'; btn.textContent = 'Done'; btn.disabled = true; running = false; } }, 1000);
  };
  paint();
}
function setField(path, value) {
  const s = S.session; const parts = path.split('.');
  if (parts.length === 2) { s[parts[0]] = s[parts[0]] || {}; s[parts[0]][parts[1]] = value; } else s[path] = value;
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) { if (S.view === 'guided') { Guided.leave(); await saveSession(); } if (S.view === 'session' || S.view === 'reflect') { await stopActiveRecording(); await saveSession(); } S.view = navBtn.dataset.nav; S.editing = false; render(); return; }
  const gt = e.target.closest('[data-g],[data-gv],[data-s],[data-prov]');
  if (gt && await Guided.onClick(gt)) return;
  const t = e.target.closest('[data-action],[data-v],[data-signal],[data-suggest],[data-prompt],[data-insert]');
  if (!t) return;
  const a = t.dataset.action;
  if (t.dataset.v) {
    const grp = t.closest('[data-scale]'); const k = STEPS[S.session.step].key; const v = +t.dataset.v;
    $$('button', grp).forEach((b) => b.setAttribute('aria-pressed', b === t ? 'true' : 'false'));
    setField(`${k}.${grp.dataset.scale}`, v); saveSoon();
    if (k === 'before' && grp.dataset.scale === 'tension') $('[data-tension-note]').classList.toggle('hidden', v < 4);
    return;
  }
  if (t.dataset.signal) {
    const s = S.session; const sig = t.dataset.signal;
    if (sig === 'none') { s.stopSignals = []; s.noSignals = true; }
    else { s.noSignals = false; const set = new Set(s.stopSignals || []); set.has(sig) ? set.delete(sig) : set.add(sig); s.stopSignals = [...set]; }
    $$('[data-signal]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.signal === 'none' ? String(!!s.noSignals) : String(s.stopSignals.includes(b.dataset.signal))));
    const urgent = s.stopSignals.some((x) => URGENT_SIGNALS.has(x));
    $('[data-urgent]').classList.toggle('hidden', !urgent);
    $('[data-signal-note]').classList.toggle('hidden', !s.stopSignals.length || urgent);
    saveSoon(); return;
  }
  if (t.dataset.suggest) {
    const sg = SUGGESTIONS[+t.dataset.suggest]; S.session.image = sg.t; S.session.source = sg.s.split(' — ')[0];
    if (sg.p) S.session.prompt = sg.p;
    $('#img').value = S.session.image; $('#src').value = S.session.source;
    $$('[data-prompt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.prompt === S.session.prompt)));
    saveSoon(); return;
  }
  if (t.dataset.prompt) {
    S.session.prompt = S.session.prompt === t.dataset.prompt ? '' : t.dataset.prompt;
    $$('[data-prompt]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.prompt === S.session.prompt)));
    saveSoon(); return;
  }
  if (t.dataset.insert) {
    const ta = $('#verb'); const ins = (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + t.dataset.insert;
    ta.value += ins; S.session.dialogue = ta.value; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); saveSoon(); return;
  }
  const phaseOf = () => { const box = t.closest('[data-recorder]'); return box ? box.dataset.recorder : 'dialogue'; };
  switch (a) {
    case 'new': await newSession(); break;
    case 'guided': await Guided.start('session'); break;
    case 'guided-continue': await Guided.start('session', t.dataset.id); break;
    case 'guided-reflect': await stopActiveRecording(); await saveSession(); await Guided.start('reflection'); break;
    case 'continue': await newSession(t.dataset.id); break;
    case 'resume': S.session = await dbGet('sessions', t.dataset.id); S.view = 'session'; render(); break;
    case 'finish-open': { const s = await dbGet('sessions', t.dataset.id); s.status = 'complete'; s.endedAt = s.endedAt || s.updatedAt || Date.now(); await dbPut('sessions', s); toast('Saved.'); render(); break; }
    case 'cancel':
      if (confirm('Cancel this session? Anything recorded in it will be deleted.')) { await stopActiveRecording(); await deleteSession(S.session.id); S.session = null; S.view = 'home'; render(); }
      break;
    case 'next': await goStep(1); break;
    case 'back': await goStep(-1); break;
    case 'gtoggle': S.groundToggle && S.groundToggle(); break;
    case 'ground-stop': S.session.stoppedEarly = true; S.session.step = STEPS.findIndex((x) => x.key === 'close'); await saveSession(); render(); break;
    case 'stop-now': await stopActiveRecording(); S.session.stoppedEarly = true; S.session.dialogueEndedAt = Date.now(); S.session.step = STEPS.findIndex((x) => x.key === 'close'); await saveSession(); render(); break;
    case 'home': S.view = 'home'; S.session = null; render(); break;
    case 'reflect-now': S.view = 'reflect'; render(); break;
    case 'rec-main': case 'rec-pause': case 'rec-stop': await recAction(a, phaseOf()); break;
    case 'clip-dl': {
      const r = await dbGet('recordings', t.dataset.id); if (!r) return;
      const s = S.session; download(new Blob([r.data], { type: r.mime }), `practice-journal_${stamp(s.createdAt)}_${r.phase}_${r.id}.${extFor(r.mime)}`); break;
    }
    case 'clip-del':
      if (confirm('Delete this recording from this device? This can’t be undone.')) {
        await dbDel('recordings', t.dataset.id); S.session.clips = S.session.clips.filter((c) => c.id !== t.dataset.id); await saveSession();
        const li = t.closest('li'); const phase = (t.closest('[data-clips]') || {}).dataset; if (li) li.remove(); toast('Recording deleted.');
      }
      break;
    case 'open': S.detailId = t.dataset.id; S.view = 'detail'; S.editing = false; render(); break;
    case 'edit': S.editing = true; render(); break;
    case 'save-edit': { const ta = $('textarea[data-field="dialogue"]'); S.session.dialogue = ta.value; await saveSession(); S.editing = false; toast('Notes saved.'); render(); break; }
    case 'reflect': S.view = 'reflect'; render(); break;
    case 'back-detail': await stopActiveRecording(); await saveSession(); S.detailId = S.session.id; S.view = 'detail'; render(); break;
    case 'save-reflect': await stopActiveRecording(); S.session.reflection = Object.assign(S.session.reflection || {}, { at: Date.now() }); await saveSession(); S.detailId = S.session.id; S.view = 'detail'; toast('Reflection saved.'); render(); break;
    case 'arc-toggle': {
      const set = new Set(await metaGet('closedArcs', [])); const id = t.dataset.arc; set.has(id) ? set.delete(id) : set.add(id);
      await metaSet('closedArcs', [...set]); toast(set.has(id) ? 'Arc closed.' : 'Arc reopened.'); render(); break;
    }
    case 'delete':
      if (confirm('Delete this session, its notes and its recordings from this device? This can’t be undone.')) { await deleteSession(t.dataset.id); S.session = null; S.view = 'history'; toast('Session deleted.'); render(); }
      break;
    case 'persist':
      if (navigator.storage && navigator.storage.persist) { const ok = await navigator.storage.persist(); toast(ok ? 'The browser will keep this data.' : 'The browser didn’t agree. Adding to the Home Screen and regular backups help.'); fillStorage(); }
      else toast('This browser doesn’t support that.');
      break;
    case 'export-zip': try { await exportZip(false); } catch (err) { toast('Export failed: ' + err.message); } break;
    case 'share-zip': try { await exportZip(true); } catch (err) { toast('Share failed: ' + err.message); } break;
    case 'export-json': await exportJson(); break;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.anchor != null) { const n = +el.dataset.anchor; metaGet('anchors', ['', '', '']).then((a) => { a[n] = el.value; metaSet('anchors', a); }); return; }
  if (el.dataset.field && S.session && S.view !== 'detail') { setField(el.dataset.field, el.value); saveSoon(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.close != null) { const s = S.session; s.closeChecks = s.closeChecks || []; s.closeChecks[+el.dataset.close] = el.checked; saveSoon(); }
  if (el.id === 'importFile' && el.files[0]) {
    try { const r = await importFile(el.files[0]); toast(`Imported ${r.added} session${r.added === 1 ? '' : 's'}, ${r.audio} recording${r.audio === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} already here` : ''}${r.missing ? `; ${r.missing} audio not in file` : ''}.`); }
    catch (err) { toast('Import failed: ' + err.message); }
    el.value = '';
  }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSession(); });
window.addEventListener('pagehide', () => { saveSession(); });

// help sheet
const sheet = $('#sheet');
$('#helpBtn').addEventListener('click', () => { sheet.hidden = false; $('#sheetClose').focus(); });
$('#sheetClose').addEventListener('click', () => { sheet.hidden = true; });
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) sheet.hidden = true; });

// boot
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage && navigator.storage.persist && (matchMedia('(display-mode: standalone)').matches || navigator.standalone)) navigator.storage.persist().catch(() => {});
try { const v = sessionStorage.getItem('pj-view'); if (v) { S.view = v; sessionStorage.removeItem('pj-view'); } } catch (e) { /* */ }
render();
window.__pj = { dbAll, dbGet, S };
