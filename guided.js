/* Guided session: speaks each template question, listens, and (optionally) uses an AI model
   the user chooses, with the user's own key, to write concise entries and ask follow-ups.
   Relies on helpers defined in app.js ($, esc, S, dbPut, metaGet, ...), used at call time. */
(function () {
  'use strict';

  // ---------- providers ----------
  const PROVIDERS = {
    anthropic: {
      name: 'Anthropic (Claude)', origin: 'https://api.anthropic.com', model: 'claude-haiku-5-5',
      models: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fast, cheapest, default)' }, { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (stronger, pricier)' }],
      keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'starts with sk-ant-',
      async call(cfg, system, user) {
        const r = await timedFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: cfg.model, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
        }, 60000);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
        return (j.content || []).map((c) => c.text || '').join('');
      },
    },
    openai: {
      name: 'OpenAI', origin: 'https://api.openai.com', model: 'gpt-5.4-mini',
      models: [{ id: 'gpt-5.4-mini', label: 'GPT-5.4 mini (fast, default)' }, { id: 'gpt-5.2', label: 'GPT-5.2 (stronger, pricier)' }],
      keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'starts with sk-',
      call: (cfg, system, user) => openaiCompatible('https://api.openai.com/v1/chat/completions', cfg, system, user),
    },
    xai: {
      name: 'xAI (Grok)', origin: 'https://api.x.ai', model: 'grok-4.20-non-reasoning',
      models: [{ id: 'grok-4.20-non-reasoning', label: 'Grok 4.20 non-reasoning (fast, default)' }, { id: 'grok-4.3', label: 'Grok 4.3 (light reasoning)' }, { id: 'grok-4.7', label: 'Grok 4.7 (strongest, slower, pricier)' }],
      keyUrl: 'https://console.x.ai', keyHint: 'starts with xai-',
      call: (cfg, system, user) => openaiCompatible('https://api.x.ai/v1/chat/completions', cfg, system, user),
    },
    custom: {
      name: 'Local / custom server', origin: '', model: '', models: [], keyHint: 'optional',
      // qwen3-style models think out loud unless told not to; /no_think is Qwen's soft switch. <think> blocks are also stripped.
      call: (cfg, system, user) => openaiCompatible(cfg.base + '/chat/completions', cfg, system, /qwen3/i.test(cfg.model) ? user + '\n/no_think' : user),
    },
  };
  // Ollama and LM Studio serve the OpenAI-compatible API under /v1; add it when the URL has no path.
  function normalizeBase(base) {
    base = String(base || '').trim().replace(/\/+$/, '');
    try { const u = new URL(base); if (u.pathname === '/' || u.pathname === '') return u.origin + '/v1'; } catch (e) { /* validated elsewhere */ }
    return base;
  }
  function timedFetch(url, opts, ms) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, Object.assign({}, opts, { signal: ctl.signal })).catch((e) => { throw e.name === 'AbortError' ? new Error('No reply after ' + Math.round(ms / 1000) + ' seconds.') : e; }).finally(() => clearTimeout(t));
  }
  function baseOrigin(base) {
    let u; try { u = new URL(base); } catch (e) { throw new Error('That isn’t a full URL. Example: https://my-pc.tailnet-name.ts.net/v1'); }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('This page is https, so the server must be https too (http works only for localhost on the same computer).');
    return u.origin;
  }
  async function openaiCompatible(url, cfg, system, user) {
    const body = { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } };
    const headers = { 'content-type': 'application/json' }; if (cfg.key) headers.authorization = 'Bearer ' + cfg.key;
    // Local models can take 30-60 s on first load, so allow much longer for a custom server.
    const send = (b) => timedFetch(url, { method: 'POST', headers, body: JSON.stringify(b) }, cfg.base ? 180000 : 60000);
    let r = await send(body); let j = await r.json().catch(() => ({}));
    // Some servers/models (LM Studio, older Ollama models) reject JSON mode: retry once without it.
    if (!r.ok && (r.status === 400 || r.status === 422 || (cfg.base && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 403 && r.status !== 404))) { delete body.response_format; r = await send(body); j = await r.json().catch(() => ({})); }
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || j.message || 'HTTP ' + r.status);
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }

  const DEFAULT_VOICE = { speak: true, rate: 1, autoSend: true, pauseSec: 4, lang: '' };
  // Stored as { provider, keys: {anthropic, openai, xai}, models: {...} }; one key per provider, kept on this device only.
  async function getAI() {
    const raw = await metaGet('ai', {}) || {};
    const provider = PROVIDERS[raw.provider] ? raw.provider : 'anthropic';
    const keys = Object.assign({}, raw.keys); const models = Object.assign({}, raw.models);
    if (raw.key && !keys[provider]) keys[provider] = raw.key; // migrate v3 format
    if (raw.model && !models[provider]) models[provider] = raw.model;
    const custom = Object.assign({ base: '', models: [] }, raw.custom);
    return { provider, keys, models, custom, key: keys[provider] || '', model: models[provider] || '' };
  }
  const saveAI = (ai) => metaSet('ai', { provider: ai.provider, keys: ai.keys, models: ai.models, custom: ai.custom });
  function syncPolicy(ai, voice) { // csp.js reads these on the next load
    let changed = false;
    try {
      let sttOrigin = localStorage.getItem('pj-stt-origin') || '';
      if (voice) { const r = resolveStt(ai, voice); const b = sttBackup(ai, voice, r); sttOrigin = r.origin || (b && b.origin) || ''; }
      if ((localStorage.getItem('pj-stt-origin') || '') !== sttOrigin) { localStorage.setItem('pj-stt-origin', sttOrigin); changed = true; }
      const want = ai.provider; const wantOrigin = ai.provider === 'custom' && ai.custom.base ? baseOrigin(ai.custom.base) : '';
      if ((localStorage.getItem('pj-provider') || 'anthropic') !== want) { localStorage.setItem('pj-provider', want); changed = true; }
      if ((localStorage.getItem('pj-custom-origin') || '') !== wantOrigin) { localStorage.setItem('pj-custom-origin', wantOrigin); changed = changed || want === 'custom'; }
    } catch (e) { /* */ }
    return changed;
  }
  function reloadToSettings() { try { sessionStorage.setItem('pj-view', 'settings'); } catch (e) { /* */ } location.reload(); }
  async function getVoice() { return Object.assign({}, DEFAULT_VOICE, await metaGet('voice', {})); }
  function cleanReply(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  }
  function parseJSON(text) {
    const t = cleanReply(text);
    const start = t.indexOf('{');
    if (start < 0) throw new Error('The AI reply wasn’t readable.');
    // try the longest balanced-looking object first, then shorter ones
    for (let end = t.lastIndexOf('}'); end > start; end = t.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { /* keep trying */ }
    }
    throw new Error('The AI reply wasn’t readable.');
  }
  const configured = (ai) => ai.provider === 'custom' ? !!(ai.custom.base && ai.model) : !!ai.key;
  // fallback(text) is used when a model answers without valid JSON (common with small local models).
  async function askAI(system, user, fallback) {
    const cfg = await getAI();
    const p = PROVIDERS[cfg.provider] || PROVIDERS.anthropic;
    if (!configured(cfg)) return null;
    const raw = await p.call({ key: cfg.key, model: cfg.model || p.model, base: cfg.custom.base }, system, user);
    try { return parseJSON(raw); } catch (e) { if (fallback) return fallback(cleanReply(raw)); throw e; }
  }

  const SYSTEM = `You are the scribe and interviewer for Julian's active imagination practice journal (C. G. Jung's method). You fill in one field of his session template at a time from what he says out loud.
Rules:
- Write the entry in his own words, first person. Be precise and concise: trim filler, repetition and false starts. Never embellish, interpret, summarize beyond what he said, or invent anything.
- Never interpret images, figures or symbols. Never give advice, reassurance, praise or therapy talk. Tone: direct, plain, brief.
- If the answer is vague, off-field, or is missing what the field needs, ask ONE short follow-up (under 20 words). If he seems to dodge, challenge him plainly once. Don't ask about optional fields beyond one try.
- If he signals distress (panic, racing heart, can't breathe, flashback or combat memory, numbness or "not here", the image feels literally real, urge to self-harm, suicidal thoughts), return action "pause".
- If he asks to skip, return action "skip".
Reply with JSON only: {"action":"fill"|"followup"|"pause"|"skip","value":<entry>,"say":"<short line to speak, may be empty>","missing":"<what is still missing, or empty>"}`;

  const DIALOGUE_RULE = 'This is the verbatim record of the imagination itself. Do NOT ask follow-ups and do NOT challenge; return action "fill". Format as lines: "ME: ..." for what Julian says, "FIGURE (name or description): ..." for what the figure says, "[scene] ..." for image or scene changes. Keep his exact words; remove only fillers (um, uh) and narration such as "and then I said". Return only the new lines.';

  // ---------- template fields ----------
  const SIGNALS = ['Heart racing / panic', 'Image felt literally real', 'Combat memory / flashback', 'Numb, “not here”', 'Urge to self-harm', 'Figure demanded action in outer life'];
  function sessionFields(s) {
    const cont = s.arcId && s.image;
    return [
      { key: 'arrive', type: 'info', label: 'Arrive', q: 'Phone on silent, water nearby. Read your three anchors aloud. Tap Continue when you’re ready.' },
      { key: 'before.mood', type: 'scale', label: 'Mood before', labels: MOOD_LABELS, q: 'Mood right now, one to five. One is very low, five is very good.', need: 'an integer 1-5' },
      { key: 'before.tension', type: 'scale', label: 'Body tension before', labels: TENSION_LABELS, q: 'Body tension, one to five. One is loose, five is very tight.', need: 'an integer 1-5' },
      { key: 'before.note', type: 'text', optional: true, label: 'Arriving note', q: 'One word or a short note for how you’re arriving.', need: 'one word or a short phrase about his state' },
      { key: 'ground', type: 'info', label: 'Ground in', q: 'Feet on the floor. Five slow breaths, out longer than in. Tap Continue when you’re done.' },
      { key: 'image', type: 'text', label: 'Starting image', q: cont ? `Continuing with “${s.image}”. Keep it, or name a change?` : 'What’s your starting point: an image, a mood, or a Red Book passage?', need: 'one specific image, mood or passage (not a general topic). If he names a Red Book chapter, use its title.' },
      { key: 'source', type: 'text', optional: true, label: 'Source or page', q: 'Source or page, if there is one. Say skip if not.', need: 'book, chapter, page or folio' },
      { key: 'imagine', type: 'info', label: 'Imagine', q: 'Close your eyes and hold the image. Wait for it to move, then step in. When you’re ready, tap Talk and speak the exchange as it happens: what you say, what the figure says, and how the scene changes. I’ll only write it down.' },
      { key: 'dialogue', type: 'append', label: 'Dialogue (verbatim)', q: 'Go ahead. I’m listening.', need: 'the verbatim exchange' },
      { key: 'close', type: 'info', label: 'Close', q: 'Closing. Eyes open, feet flat, press down for ten seconds. Say today’s date and your next task out loud. Close the book. Tap Continue.' },
      { key: 'after.mood', type: 'scale', label: 'Mood after', labels: MOOD_LABELS, q: 'Mood now, one to five.', need: 'an integer 1-5' },
      { key: 'after.tension', type: 'scale', label: 'Body tension after', labels: TENSION_LABELS, q: 'Body tension now, one to five.', need: 'an integer 1-5' },
      { key: 'after.note', type: 'text', optional: true, label: 'Leaving note', q: 'A word or note for how you’re leaving.', need: 'one word or a short phrase' },
      { key: 'stopSignals', type: 'signals', label: 'Stop signals', q: 'Any stop signals today? Panic, the image feeling literally real, a combat memory, numbness, an urge to self-harm, or a figure demanding action. Or none.', need: 'which of these occurred: ' + SIGNALS.join('; ') + '. Use exactly these labels, or ["none"].' },
    ];
  }
  const REFLECTION_FIELDS = [
    { key: 'reflection.affected', type: 'text', label: 'How am I affected by this?', q: 'How are you affected by this session?', need: 'his honest reaction: feelings, body, thoughts. Specific, not generic.' },
    { key: 'reflection.resisted', type: 'text', label: 'What did the figure want that I resisted?', q: 'What did the figure want that you resisted?', need: 'a specific want of the figure and how he resisted it' },
    { key: 'reflection.action', type: 'text', label: 'One concrete action (by when)', q: 'One concrete action this implies, and by when?', need: 'ONE specific behavior AND a deadline. If either is missing, ask for it.' },
    { key: 'reflection.power', type: 'text', label: 'Power-principle check', q: 'Power-principle check: how could you misuse this insight?', need: 'a specific way he could misuse it (to control, justify, feel superior, or avoid)' },
  ];

  // ---------- state ----------
  const G = { mode: 'session', fields: [], idx: 0, convo: [], followups: 0, state: 'idle', say: '', tip: '', error: '', srBroken: false, listener: null, gaps: [], reviewing: false, paused: false, highTension: false, more: false, hasKey: false, voice: DEFAULT_VOICE, base: '', returnToReview: false };
  const getPath = (path) => { const s = S.session; const [a, b] = path.split('.'); return b ? (s[a] || {})[b] : s[a]; };
  const DISTRESS = /(suicid|kill myself|end my life|end it all|hurt myself|self[- ]?harm|panic attack|i'?m panicking|can'?t breathe|heart (is )?(racing|pounding)|flashback|i'?m not here|feel(ing)? numb|it (feels|felt) (literally )?real)/i;
  const cur = () => G.fields[G.idx];

  // ---------- speech ----------
  function speak(text) {
    return new Promise((resolve) => {
      if (!G.voice.speak || !window.speechSynthesis || !text) return resolve();
      let done = false; const fin = () => { if (!done) { done = true; resolve(); } };
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = G.voice.rate || 1; if (G.voice.lang) u.lang = G.voice.lang;
        u.onend = fin; u.onerror = fin;
        setTimeout(fin, 1200 + text.length * 70 / (G.voice.rate || 1)); // iOS sometimes never fires onend
        speechSynthesis.speak(u);
      } catch (e) { fin(); }
    });
  }
  function stopSpeech() { try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* */ } }
  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  // Browser live transcription. Must be started from a tap. A fresh recognizer is made every time.
  const SR_ERRORS = {
    'not-allowed': 'Speech recognition permission was denied.',
    'service-not-allowed': 'Speech recognition is turned off for this browser or app (on iPhone it needs Siri/Dictation on, and it isn’t always available in Home Screen apps).',
    'audio-capture': 'No microphone was available to speech recognition.',
    'network': 'Speech recognition needs a network connection and couldn’t reach its service.',
    'no-speech': 'No speech was heard.',
    'language-not-supported': 'This language isn’t supported by the browser’s speech recognition.',
  };
  function listen(onText, onStatus) {
    let rec, resolveFn, rejectFn, finalText = '', interim = '', got = false, heard = false, silenceT, watchT, settled = false;
    const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(silenceT); clearTimeout(watchT); fn(v); };
    const fail = (code, msg) => { const e = new Error(msg || SR_ERRORS[code] || ('Speech recognition error: ' + code)); e.code = code; settle(rejectFn, e); try { rec && rec.abort(); } catch (er) { /* */ } };
    const Ctor = SR();
    if (!Ctor) { fail('unsupported', 'This browser has no live speech recognition.'); return { promise: p, stop() {} }; }
    try {
      rec = new Ctor();
      rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
      rec.lang = G.voice.lang || navigator.language || 'en-US';
      rec.onstart = () => onStatus('Mic on. Start speaking.');
      rec.onaudiostart = () => onStatus('Mic on. Start speaking.');
      rec.onsoundstart = () => { heard = true; onStatus('Hearing sound…'); };
      rec.onspeechstart = () => { heard = true; onStatus('Hearing you…'); };
      rec.onresult = (e) => {
        got = true; heard = true; interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]; const t = (r[0] && r[0].transcript) || '';
          if (r.isFinal) finalText += t.trim() + ' '; else interim += t;
        }
        onText((finalText + interim).trim());
        onStatus('Hearing you… tap Done when finished');
        clearTimeout(silenceT);
        if (G.voice.autoSend) silenceT = setTimeout(() => { try { rec.stop(); } catch (er) { /* */ } }, (G.voice.pauseSec || 4) * 1000 * (cur() && cur().type === 'append' ? 1.75 : 1));
      };
      rec.onerror = (e) => {
        if (e.error === 'aborted' && settled) return;
        if (e.error === 'no-speech' && got) return;
        fail(e.error || 'error');
      };
      rec.onend = () => { if (!got && !settled) return fail('ended-empty', heard ? 'Speech recognition stopped before it produced any words.' : 'Speech recognition stopped without hearing anything.'); settle(resolveFn, (finalText + interim).trim()); };
      // Known WebKit bug: the mic opens but no words ever arrive. Give up after 8 s of nothing.
      watchT = setTimeout(() => { if (!got) fail('silent', 'Live transcription started but heard nothing (a known iPhone/Safari problem).'); }, 8000);
      rec.start();
    } catch (e) { fail('start-failed', 'Speech recognition couldn’t start: ' + e.message); }
    return { promise: p, stop() { try { rec && rec.stop(); } catch (e) { /* */ } } };
  }

  // Record & Transcribe: records the answer with MediaRecorder, then sends the clip to a transcription service.
  function answerRecorder(onStatus) {
    let stream, mr, chunks = [], startT, tick, maxT, resolveFn, rejectFn, settled = false, cancelled = false;
    const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    const cleanup = () => { clearInterval(tick); clearTimeout(maxT); if (stream) stream.getTracks().forEach((t) => t.stop()); };
    (async () => {
      try {
        if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('This browser can’t record audio.');
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (cancelled) { cleanup(); return; }
        const mime = pickMime();
        mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = () => { cleanup(); if (settled) return; settled = true; resolveFn(cancelled ? null : new Blob(chunks, { type: mr.mimeType || mime || 'audio/webm' })); };
        mr.start(500); startT = Date.now();
        const show = () => onStatus('● Recording ' + fmtDur(Date.now() - startT) + ' · tap Stop when you’re done');
        show(); tick = setInterval(show, 500);
        maxT = setTimeout(() => { try { mr.stop(); } catch (e) { /* */ } }, 5 * 60 * 1000);
      } catch (e) {
        cleanup(); if (settled) return; settled = true;
        rejectFn(new Error(e.name === 'NotAllowedError' ? 'Microphone access was denied.' : e.message || 'Couldn’t start recording.'));
      }
    })();
    return { promise: p, stop() { try { if (mr && mr.state !== 'inactive') mr.stop(); else { cancelled = true; } } catch (e) { /* */ } }, cancel() { cancelled = true; this.stop(); } };
  }
  async function transcribe(blob, stt) {
    const ext = extFor(blob.type); const fd = new FormData(); const lang = (G.voice.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    let url;
    if (stt.kind === 'openai') { url = 'https://api.openai.com/v1/audio/transcriptions'; fd.append('model', 'gpt-4o-mini-transcribe'); fd.append('language', lang); }
    else if (stt.kind === 'xai') { url = 'https://api.x.ai/v1/stt'; fd.append('model', 'grok-voice-transcribe-2.0'); fd.append('language', lang); fd.append('format', 'true'); }
    else { url = stt.base + '/audio/transcriptions'; fd.append('model', stt.model || 'whisper-1'); }
    fd.append('file', blob, 'answer.' + ext); // xAI requires the file last
    const headers = stt.key ? { authorization: 'Bearer ' + stt.key } : {};
    const r = await timedFetch(url, { method: 'POST', headers, body: fd }, 120000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || j.message || 'HTTP ' + r.status);
    return String(j.text || '').trim();
  }
  const STT_LABELS = { browser: 'Browser live transcription', openai: 'Record & Transcribe (OpenAI)', xai: 'Record & Transcribe (xAI)', local: 'Record & Transcribe (your server)', keyboard: 'Keyboard dictation' };
  // Decide how the Talk button turns speech into text on this device.
  function resolveStt(ai, voice) {
    const make = (kind, problem) => {
      const o = { kind, label: STT_LABELS[kind], problem: problem || '' };
      if (kind === 'openai') Object.assign(o, { key: ai.keys.openai, origin: 'https://api.openai.com' });
      if (kind === 'xai') Object.assign(o, { key: ai.keys.xai, origin: 'https://api.x.ai' });
      if (kind === 'local') { o.base = normalizeBase(voice.sttBase); o.model = voice.sttModel || ''; o.key = ai.keys.custom || ''; try { o.origin = baseOrigin(o.base); } catch (e) { return make(SR() ? 'browser' : 'keyboard', e.message); } }
      return o;
    };
    const pick = voice.stt || 'auto';
    if (pick === 'openai') return ai.keys.openai ? make('openai') : make('keyboard', 'Record & Transcribe (OpenAI) needs an OpenAI key.');
    if (pick === 'xai') return ai.keys.xai ? make('xai') : make('keyboard', 'Record & Transcribe (xAI) needs an xAI key.');
    if (pick === 'local') return voice.sttBase ? make('local') : make('keyboard', 'Add your transcription server address.');
    if (pick === 'browser') return SR() ? make('browser') : make('keyboard', 'This browser has no live speech recognition.');
    if (pick === 'keyboard') return make('keyboard');
    if (ai.provider === 'xai' && ai.keys.xai) return make('xai');
    if (ai.provider === 'openai' && ai.keys.openai) return make('openai');
    if (ai.provider === 'custom' && voice.sttBase) return make('local'); // keep a self-hosted setup self-hosted
    if (ai.keys.openai) return make('openai');
    if (ai.keys.xai) return make('xai');
    if (voice.sttBase) return make('local');
    if (SR()) return make('browser');
    return make('keyboard');
  }
  // When live (browser) transcription is in use, the Record & Transcribe option to switch to if it fails.
  function sttBackup(ai, voice, r) {
    if (r.kind !== 'browser') return null;
    let alt = resolveStt(ai, Object.assign({}, voice, { stt: 'auto' }));
    if (!['openai', 'xai', 'local'].includes(alt.kind) && voice.sttBase) alt = resolveStt(ai, Object.assign({}, voice, { stt: 'local' }));
    return ['openai', 'xai', 'local'].includes(alt.kind) ? alt : null;
  }
  function stopListening(discard) { if (G.listener) { const l = G.listener; G.listener = null; if (discard) l.discard = true; l.stop(); } }

  // ---------- flow ----------
  async function start(mode, fromId) {
    if (S.rec && S.rec.state !== 'idle') { await stopActiveRecording(); toast('Audio recording stopped and saved. Guided mode uses the microphone for talking.'); }
    G.voice = await getVoice(); { const ai = await getAI(); G.hasKey = configured(ai); G.local = ai.provider === 'custom'; G.stt = resolveStt(ai, G.voice); G.sttAlt = sttBackup(ai, G.voice, G.stt); G.srFails = 0; }
    G.mode = mode; G.idx = 0; G.reviewing = false; G.paused = false; G.gaps = []; G.error = ''; G.tip = ''; G.srBroken = false; G.returnToReview = false;
    if (mode === 'session') {
      const s = { id: uid(), status: 'in-progress', guided: true, createdAt: Date.now(), startedAt: Date.now(), step: 0, before: {}, after: {}, clips: [], stopSignals: [], closeChecks: [] };
      if (fromId) {
        const prev = await dbGet('sessions', fromId);
        if (prev) {
          s.arcId = prev.arcId || prev.id; s.image = prev.image; s.source = prev.source;
          s.arcIndex = (await allSessions()).filter((x) => (x.arcId || x.id) === s.arcId && x.status === 'complete').length + 1;
          if (!prev.arcId) { prev.arcId = prev.id; await dbPut('sessions', prev); }
        }
      }
      S.session = s; await saveSession();
      G.fields = sessionFields(s);
    } else {
      S.session.reflection = S.session.reflection || {};
      G.fields = REFLECTION_FIELDS;
    }
    S.view = 'guided'; await render();
    beginField();
  }
  async function beginField() {
    const f = cur(); if (!f) return review();
    G.convo = []; G.followups = 0; G.say = ''; G.error = ''; G.more = false; G.highTension = false;
    if (f.key === 'dialogue' && !S.session.dialogueStartedAt) { S.session.dialogueStartedAt = Date.now(); saveSoon(); }
    paint();
    G.state = 'speaking'; status();
    await speak(f.q);
    if (S.view !== 'guided' || cur() !== f || G.paused) return;
    G.state = 'idle'; status();
  }
  // Called only from a tap on Talk (iOS needs a direct user gesture to open speech recognition or the mic).
  function startVoice() {
    if (G.listener || G.paused) return;
    stopSpeech();
    const box = $('#gAnswer'); if (!box) return;
    G.error = ''; errPaint(); G.tip = ''; tipPaint();
    const stt = G.stt || { kind: 'keyboard' };
    if (stt.kind === 'keyboard') { keyboardTip(stt.problem); box.focus(); return; }
    G.base = box.value ? box.value.trim() + ' ' : '';
    const live = (t) => { G.live = t; const el = $('[data-gstatus]'); if (el) el.textContent = t; };
    if (stt.kind === 'browser') {
      const l = listen((t) => { const b = $('#gAnswer'); if (b) b.value = G.base + t; }, live);
      l.kind = 'browser'; G.listener = l; G.state = 'listening'; live('Starting live transcription…'); status(true);
      l.promise.then(() => {
        if (G.listener === l) G.listener = null;
        G.state = 'idle'; status();
        if (l.discard) return;
        const b = $('#gAnswer'); const all = b ? b.value.trim() : '';
        if (all && (G.voice.autoSend || l.userDone)) submit(all); else if (all) live('Check your words, then tap Send.');
      }).catch((err) => {
        if (G.listener === l) G.listener = null;
        G.state = 'idle'; status();
        if (l.discard) return;
        G.srFails = (G.srFails || 0) + 1;
        const alt = G.sttAlt;
        if (alt && (G.srFails >= 1)) { G.stt = alt; G.sttAlt = null; G.tip = err.message + ' Switched to ' + alt.label + ' for this session. Tap Talk again.'; tipPaint(); status(); return; }
        keyboardTip(err.message + (err.code ? ' (' + err.code + ')' : ''));
      });
    } else {
      const rec = answerRecorder(live);
      const l = { kind: 'record', stop: () => rec.stop(), promise: rec.promise };
      G.listener = l; G.state = 'recording'; live('Opening the microphone…'); status(true);
      rec.promise.then(async (blob) => {
        if (G.listener === l) G.listener = null;
        if (l.discard || !blob) { G.state = 'idle'; status(); return; }
        if (blob.size < 1200) { G.state = 'idle'; status(); live('That was too short to transcribe. Tap Talk and try again.'); return; }
        G.state = 'transcribing'; status();
        try {
          const text = await transcribe(blob, stt);
          G.state = 'idle'; status();
          if (!text) { live('No words were recognized. Tap Talk and try again, a little closer to the mic.'); return; }
          const b = $('#gAnswer'); if (b) b.value = G.base + text;
          if (G.voice.autoSend) submit(G.base + text); else live('Check your words, then tap Send.');
        } catch (e) {
          G.state = 'idle'; status();
          G.tip = 'Transcription failed: ' + e.message + ' Tap Talk to try again, or type your answer.'; tipPaint();
        }
      }).catch((e) => { if (G.listener === l) G.listener = null; G.state = 'idle'; status(); keyboardTip(e.message); });
    }
  }
  function keyboardTip(reason) {
    G.tip = (reason ? reason + ' ' : '') + 'Tap the answer box, then tap the microphone on your keyboard to dictate, and tap Send.';
    tipPaint();
  }
  async function submit(text) {
    const f = cur(); if (!f || f.type === 'info') return;
    stopListening(true);
    const box = $('#gAnswer'); if (box) box.value = '';
    text = text.trim(); if (!text) return;
    if (/^(skip|next|skip it|pass)[.!]?$/i.test(text)) return next();
    if (/^(go )?back[.!]?$/i.test(text)) return back();
    if (/^(pause|stop)[.!]?$/i.test(text)) return pause('Paused. Tap Resume when you’re ready.');
    if (DISTRESS.test(text)) return pause();
    G.convo.push({ who: 'Julian', text });
    G.state = 'thinking'; status();
    let r;
    if (!G.hasKey) r = localFill(f, text);
    else {
      try { r = await askAI(SYSTEM + (f.type === 'append' ? '\n' + DIALOGUE_RULE : ''), fieldPrompt(f), (txt) => (f.type === 'text' || f.type === 'append') && txt && txt.length < 2000 ? { action: 'fill', value: txt } : localFill(f, text)); }
      catch (e) { G.state = 'idle'; G.error = 'AI request failed: ' + e.message; G.lastText = text; status(); errPaint(); return; }
    }
    G.state = 'idle'; status();
    await handle(f, r || localFill(f, text));
  }
  function localFill(f, text) {
    if (f.type === 'scale') { const n = parseScale(text); return n ? { action: 'fill', value: n } : { action: 'followup', say: 'Just a number, one to five.' }; }
    if (f.type === 'signals') return { action: 'fill', value: /^(none|no|nope|nothing)\b/i.test(text) ? ['none'] : SIGNALS.filter((x) => new RegExp(x.split(/[ /,“”]/)[0], 'i').test(text)).concat(SIGNALS.some((x) => new RegExp(x.split(/[ /,“”]/)[0], 'i').test(text)) ? [] : [text]) };
    return { action: 'fill', value: text };
  }
  function parseScale(t) {
    const m = String(t).match(/\b([1-5])\b/); if (m) return +m[1];
    const w = { one: 1, two: 2, three: 3, four: 4, five: 5 }; const m2 = String(t).toLowerCase().match(/\b(one|two|three|four|five)\b/); return m2 ? w[m2[1]] : 0;
  }
  function fieldPrompt(f) {
    const s = S.session;
    const ctx = { starting_image: s.image || '', source: s.source || '', mood_before: (s.before || {}).mood, tension_before: (s.before || {}).tension };
    return `FIELD: ${f.label}
WHAT IT NEEDS: ${f.need || ''}
TYPE: ${f.type}${f.type === 'scale' ? ' (value must be an integer 1-5)' : f.type === 'signals' ? ' (value must be a JSON array of strings)' : ' (value must be a string)'}
OPTIONAL: ${f.optional ? 'yes' : 'no'}
CURRENT VALUE: ${JSON.stringify(f.type === 'append' ? '' : getPath(f.key) || '')}
FOLLOW-UPS ALREADY ASKED: ${G.followups}${G.followups >= 2 ? ' (limit reached: return action "fill" now with what he gave, and put what is missing in "missing")' : ''}
SESSION CONTEXT: ${JSON.stringify(ctx)}
CONVERSATION FOR THIS FIELD:
Q: ${f.q}
${G.convo.map((c) => (c.who === 'Julian' ? 'JULIAN: ' : 'Q: ') + c.text).join('\n')}`;
  }
  async function handle(f, r) {
    const act = r.action;
    if (act === 'pause') return pause(r.say);
    if (act === 'skip') return next();
    if (act === 'followup' && G.followups < 3) {
      G.followups++; G.say = r.say || 'Can you be more specific?'; G.convo.push({ who: 'Q', text: G.say }); paintSay();
      G.state = 'speaking'; status(); await speak(G.say); G.state = 'idle'; status();
      return;
    }
    // fill
    let v = r.value;
    if (f.type === 'scale') { v = parseInt(v, 10); if (!(v >= 1 && v <= 5)) v = parseScale(String(r.value)) || getPath(f.key); }
    if (f.type === 'signals') {
      v = Array.isArray(v) ? v : [String(v || '')];
      const none = v.length === 0 || v.some((x) => /^none$/i.test(String(x).trim()));
      S.session.stopSignals = none ? [] : v.map(String).filter(Boolean); S.session.noSignals = none;
      await saveSession();
      if (S.session.stopSignals.some((x) => /self-harm|suicid/i.test(x))) return pause('Thank you for saying it. Please reach out now.', true);
      return next();
    }
    if (f.type === 'append') {
      const prev = S.session.dialogue ? S.session.dialogue.replace(/\s+$/, '') + '\n' : '';
      S.session.dialogue = prev + String(v || '').trim(); await saveSession();
      G.more = true; G.say = ''; paint();
      return;
    }
    setField(f.key, f.type === 'scale' ? v : String(v == null ? '' : v).trim());
    if (r.missing && !f.optional) { S.session.gapNotes = S.session.gapNotes || {}; S.session.gapNotes[f.key] = r.missing; }
    else if (S.session.gapNotes) delete S.session.gapNotes[f.key];
    await saveSession();
    if (f.key === 'before.tension' && v >= 4) { G.highTension = true; paint(); await speak('Tension is high. Your template says ground and don’t start today. Ground and stop, or continue?'); return; }
    if (r.say && r.say.length < 120) { G.say = r.say; }
    next();
  }
  function next() {
    stopListening(true); stopSpeech();
    if (cur() && cur().key === 'dialogue') { S.session.dialogueEndedAt = Date.now(); saveSoon(); }
    if (G.returnToReview) { G.returnToReview = false; return review(); }
    G.idx++;
    if (G.idx >= G.fields.length) return review();
    beginField();
  }
  function back() { stopListening(true); stopSpeech(); if (G.reviewing) { G.reviewing = false; G.idx = G.fields.length - 1; } else G.idx = Math.max(0, G.idx - 1); beginField(); }
  function pause(say, urgent) {
    stopListening(true); stopSpeech();
    G.paused = true; G.urgent = !!urgent; G.state = 'paused';
    S.session.guidedPaused = (S.session.guidedPaused || 0) + 1; saveSoon();
    paint();
    G.voice.speak && speak(say || 'Let’s pause here. Eyes open, feet on the floor. Breathe out longer than in.');
  }
  function resume() { G.paused = false; G.urgent = false; stopSpeech(); beginField(); }

  // ---------- review ----------
  async function review() {
    stopListening(true); stopSpeech();
    G.reviewing = true; G.state = 'thinking'; G.gaps = []; paint();
    const req = G.fields.filter((f) => f.type !== 'info');
    const values = req.map((f) => ({ key: f.key, label: f.label, needs: f.need, optional: !!f.optional, value: f.type === 'append' ? S.session.dialogue || '' : f.type === 'signals' ? (S.session.noSignals ? ['none'] : S.session.stopSignals || []) : getPath(f.key) }));
    let gaps = values.filter((x) => !x.optional && (x.value == null || x.value === '' || (Array.isArray(x.value) && !x.value.length))).map((x) => ({ key: x.key, issue: 'Empty' }));
    let say = '';
    if (G.hasKey) {
      try {
        const r = await askAI(`You review a completed journal entry for Julian's active imagination practice. Check each required field against what it needs. Flag only real gaps: empty, too vague to be useful, or missing a required part (for example an action without a deadline). Do not judge or interpret content. Do not flag optional fields. Reply with JSON only: {"gaps":[{"key":"<field key>","issue":"<under 15 words>"}],"say":"<one short spoken sentence>"}`, JSON.stringify(values), () => null);
        if (r && Array.isArray(r.gaps)) { gaps = r.gaps.filter((g) => values.some((v) => v.key === g.key)); say = r.say || ''; }
      } catch (e) { G.error = 'AI review failed (' + e.message + '). Showing basic checks only.'; }
    }
    G.gaps = gaps; G.state = 'idle'; paint();
    speak(say || (gaps.length ? `${gaps.length} item${gaps.length > 1 ? 's' : ''} to look at before saving.` : 'Everything’s filled in. Review and save.'));
  }
  async function saveAll() {
    stopListening(true); stopSpeech();
    $$('[data-rfield]').forEach((el) => setField(el.dataset.rfield, el.value));
    $$('[data-rsignals]').forEach((el) => { const v = el.value.split(',').map((x) => x.trim()).filter(Boolean); const none = !v.length || v.some((x) => /^none$/i.test(x)); S.session.stopSignals = none ? [] : v; S.session.noSignals = none; });
    if (G.mode === 'session') {
      S.session.status = 'complete'; S.session.endedAt = Date.now(); S.session.step = STEPS.length - 1;
      await saveSession(); S.view = 'session'; toast('Saved on this device.'); render();
    } else {
      S.session.reflection.at = Date.now(); await saveSession(); S.detailId = S.session.id; S.view = 'detail'; toast('Reflection saved.'); render();
    }
  }

  // ---------- views ----------
  function fieldEditor(f, compact) {
    if (f.type === 'scale') {
      const v = getPath(f.key);
      return `<div class="scale" data-gscale="${f.key}">${f.labels.map((l, i) => `<button type="button" data-gv="${i + 1}" aria-pressed="${v === i + 1}"><strong>${i + 1}</strong><span>${esc(l)}</span></button>`).join('')}</div>`;
    }
    if (f.type === 'signals') {
      const v = S.session.noSignals ? 'none' : (S.session.stopSignals || []).join(', ');
      return `<input type="text" data-rsignals value="${esc(v)}" placeholder="none, or which signals">`;
    }
    const val = f.type === 'append' ? S.session.dialogue || '' : getPath(f.key) || '';
    return `<textarea data-rfield="${f.type === 'append' ? 'dialogue' : f.key}" class="${f.type === 'append' ? 'verbatim' : ''} ${compact ? 'short' : ''}" placeholder="${f.optional ? 'Optional' : 'Empty'}">${esc(val)}</textarea>`;
  }
  function viewGuided() {
    if (G.reviewing) return viewReview();
    const f = cur(); const n = G.fields.length;
    let h = `<div class="progress" aria-hidden="true">${G.fields.map((_, k) => `<span class="${k <= G.idx ? 'done' : ''}"></span>`).join('')}</div>
      <div class="row between"><div class="steplabel">${G.mode === 'session' ? 'Guided session' : 'Guided reflection'} · ${G.idx + 1} of ${n} · ${esc(f.label)}</div>
      <button class="linkbtn" data-g="exit">Exit</button></div>`;
    if (!G.hasKey) h += `<div class="note small">No AI key set, so your words go into each field as spoken, with no follow-ups. <button class="linkbtn" data-nav="settings">Add a key in Settings</button></div>`;
    if (G.paused) {
      return h + `<div class="card"><h2>Paused</h2>
        ${G.urgent ? '<p><strong>Please reach out now.</strong></p>' : ''}
        <ol class="tight"><li>Eyes open. Feet flat. Press down for 10 seconds.</li><li>Breathe in 4, out 6, five rounds.</li><li>Name 5 things you see, 4 you hear, 3 you can touch.</li><li>Say the date, where you are, and your next task.</li><li>Stand, drink water, walk a few minutes.</li></ol>
        <div class="crisis"><strong>Veterans Crisis Line</strong><div class="crisis-actions"><a class="btn" href="tel:988">Call 988, then press 1</a><a class="btn ghost" href="sms:838255">Text 838255</a></div></div>
        <div class="row"><button class="btn quiet" data-g="resume">Resume</button><button class="btn ghost" data-g="review">End and review what’s here</button></div></div>`;
    }
    h += `<div class="card gq"><h1 class="gquestion">${esc(f.q)}</h1>`;
    if (f.key === 'arrive') h += `<div class="anchors">${'<p class="muted small" data-anchors>Your anchors appear here once you add them in a manual session.</p>'}</div>`;
    if (f.key === 'image' && S.session.arcIndex) h += `<p class="muted small">${esc(ARC_FOCUS(S.session.arcIndex))}</p><div data-reentry></div>`;
    h += `<p class="gsay" data-gsay>${esc(G.say)}</p></div>`;
    if (G.highTension) {
      h += `<div class="note warn">Tension is high. Your template says: ground and don’t start today.<div class="row mt8"><button class="btn quiet" data-g="ground-stop">Ground and stop for today</button><button class="btn ghost" data-g="continue-anyway">Continue anyway</button></div></div>`;
    }
    if (f.type === 'info') {
      h += `<div class="navrow"><button class="btn ghost" data-g="back" ${G.idx ? '' : 'disabled'}>Back</button><button class="btn" data-g="next">Continue</button></div>`;
    } else {
      h += `<div class="card talk">
        <button class="talkbtn" data-g="talk" aria-label="Talk">Talk</button>
        <div class="recstate" data-gstatus aria-live="polite"></div>
        <div class="muted small" data-gmode></div>
        <textarea id="gAnswer" class="answer" placeholder="Your words appear here. You can also type or use the keyboard mic."></textarea>
        <div class="tip hidden" data-gtip></div>
        <div class="err hidden" data-gerr></div>
        <div class="row mt8"><button class="btn ghost" data-g="back" ${G.idx ? '' : 'disabled'}>Back</button><button class="btn ghost" data-g="skip">Skip</button><button class="btn" data-g="send">Send</button></div>
      </div>`;
      h += `<div class="card"><div class="steplabel">Entry ${f.optional ? '(optional)' : ''} · edit any time</div>${fieldEditor(f)}</div>`;
      if (f.type === 'append' && G.more) {
        h += `<div class="row"><button class="btn quiet" data-g="talk">Add more</button><button class="btn" data-g="next">Close the dialogue</button></div>`;
      }
    }
    h += `<p class="muted small center">Audio recording is off during a guided session: on iPhone the microphone can’t reliably record and transcribe at once. Use “Session on my own” to keep an audio recording.</p>`;
    return h;
  }
  function viewReview() {
    const req = G.fields.filter((f) => f.type !== 'info');
    const gapBy = new Map(G.gaps.map((g) => [g.key, g.issue]));
    let h = `<div class="steplabel">${G.mode === 'session' ? 'Guided session' : 'Guided reflection'} · Review</div><h1>Review before saving</h1>`;
    if (G.state === 'thinking') return h + '<p class="muted">Checking for gaps…</p>';
    if (G.error) h += `<div class="note warn small">${esc(G.error)}</div>`;
    h += G.gaps.length ? `<div class="note warn">${G.gaps.length} item${G.gaps.length > 1 ? 's' : ''} flagged. Fix by hand, or tap “Fill by voice”.</div>` : '<div class="note">No gaps found. Edit anything you like, then save.</div>';
    h += req.map((f) => `<div class="card ${gapBy.has(f.key) ? 'gap' : ''}"><div class="row between"><div class="steplabel">${esc(f.label)}${f.optional ? ' (optional)' : ''}</div>
      <button class="linkbtn" data-g="redo" data-key="${f.key}">Fill by voice</button></div>
      ${gapBy.has(f.key) ? `<p class="gapnote">${esc(gapBy.get(f.key))}</p>` : ''}${fieldEditor(f, true)}</div>`).join('');
    h += `<div class="navrow"><button class="btn ghost" data-g="back">Back</button><button class="btn" data-g="save">Save entry</button></div>`;
    return h;
  }
  async function afterGuided() {
    const a = $('[data-anchors]');
    if (a) { const an = (await metaGet('anchors', [])).filter(Boolean); if (an.length) a.outerHTML = `<ol class="tight">${an.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`; }
    const re = $('[data-reentry]');
    if (re && S.session.arcId) {
      const prev = (await allSessions()).find((x) => (x.arcId || x.id) === S.session.arcId && x.id !== S.session.id && x.status === 'complete');
      const lines = prev && (prev.dialogue || '').trim().split('\n').filter(Boolean).slice(-5).join('\n');
      if (lines) re.innerHTML = `<div class="steplabel">Re-entry cue: last 5 lines</div><div class="pre">${esc(lines)}</div>`;
    }
    status(); tipPaint(); errPaint();
  }
  function paint() { if (S.view !== 'guided') return; $('#app').innerHTML = viewGuided(); afterGuided(); }
  function paintSay() { const el = $('[data-gsay]'); if (el) el.textContent = G.say; }
  function status(keepText) {
    const el = $('[data-gstatus]'); const b = $('.talkbtn');
    if (!el) return;
    const kb = !G.stt || G.stt.kind === 'keyboard';
    const map = { thinking: G.local ? 'Writing it up… (a local model can take up to a minute the first time)' : 'Writing it up…', transcribing: 'Transcribing…', speaking: 'Speaking… tap Talk to answer now', idle: kb ? 'Type your answer or use the keyboard mic, then tap Send.' : 'Tap Talk to answer.' };
    if (!keepText && map[G.state] !== undefined) el.textContent = map[G.state];
    const busy = G.state === 'listening' || G.state === 'recording';
    if (b) { b.classList.toggle('recording', busy); b.textContent = G.state === 'recording' ? 'Stop' : G.state === 'listening' ? 'Done' : kb ? 'Type' : 'Talk'; b.disabled = G.state === 'thinking' || G.state === 'transcribing'; }
    const m = $('[data-gmode]'); if (m && G.stt) m.textContent = 'Voice input: ' + G.stt.label + (G.stt.problem ? ' · ' + G.stt.problem : '');
  }
  function tipPaint() { const el = $('[data-gtip]'); if (el) { el.textContent = G.tip; el.classList.toggle('hidden', !G.tip); } }
  function errPaint() {
    const el = $('[data-gerr]'); if (!el) return;
    el.classList.toggle('hidden', !G.error);
    el.innerHTML = G.error ? `${esc(G.error)}<div class="row mt8"><button class="btn quiet" data-g="retry">Try again</button><button class="btn ghost" data-g="asis">Use my words as-is</button></div>` : '';
  }

  // ---------- settings ----------
  async function viewSettings() {
    const ai = await getAI(); const v = await getVoice(); const p = PROVIDERS[ai.provider] || PROVIDERS.anthropic;
    return `<h1>Settings</h1>
    <div class="card"><div class="steplabel">AI for guided sessions</div>
      <label class="field" for="aiProv">Provider</label>
      <div class="chips">${Object.entries(PROVIDERS).map(([k, x]) => `<button class="chip" data-prov="${k}" aria-pressed="${ai.provider === k}">${esc(x.name)}</button>`).join('')}</div>
      ${ai.provider === 'custom' ? `<label class="field" for="aiBase">Server base URL</label>
      <input type="url" id="aiBase" value="${esc(ai.custom.base)}" placeholder="https://my-pc.tailnet-name.ts.net/v1" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="note small">This page is https, so your server must be https too, and it must allow this site in CORS. Example: Ollama behind Tailscale Serve (<code>tailscale serve --bg 11434</code>) with <code>OLLAMA_ORIGINS=https://cavarjj-dev.github.io</code>; enter <code>https://your-pc.your-tailnet.ts.net</code> (the app adds <code>/v1</code>). LM Studio works the same way (port 1234, enable CORS). <code>http://localhost:11434/v1</code> only works in a browser on that same computer. Text then goes only to your machine.</div>
      <div class="row mt8"><button class="btn quiet" data-s="load-models">Load models</button></div>` : ''}
      <label class="field" for="aiModelSel">Model</label>
      ${(() => { const list = ai.provider === 'custom' ? ai.custom.models.map((id) => ({ id, label: id })) : p.models; const cur = ai.model || p.model; const known = !!cur && list.some((m) => m.id === cur); return `<select id="aiModelSel" class="select">${list.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}<option value="__custom" ${known ? '' : 'selected'}>Custom model name…</option></select>
      <input type="text" id="aiModel" class="${known ? 'hidden' : ''} mt8" value="${known ? '' : esc(cur)}" placeholder="Exact model name from the provider" autocomplete="off" autocapitalize="off" spellcheck="false">`; })()}
      <label class="field" for="aiKey">API key</label>
      <input type="password" id="aiKey" value="" placeholder="${ai.key ? 'Key saved on this device (•••• ' + esc(ai.key.slice(-4)) + ')' : 'Paste your key (' + esc(p.keyHint) + ')'}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="muted small">Keys are saved per provider${Object.keys(PROVIDERS).filter((k) => ai.keys[k]).length ? ' (saved: ' + esc(Object.keys(PROVIDERS).filter((k) => ai.keys[k]).map((k) => PROVIDERS[k].name).join(', ')) + ')' : ''}, so switching doesn’t erase the others.${ai.provider === 'xai' ? ' A Grok or SuperGrok app subscription doesn’t include API credits; API usage is billed separately in the xAI console.' : ''}</p>
      ${p.keyUrl ? `<p class="muted small">Get a key at <a href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">${esc(p.keyUrl.replace('https://', ''))}</a>.</p>` : '<p class="muted small">Key is optional; leave it empty unless your server requires one.</p>'}
      <div class="row"><button class="btn" data-s="save-ai">Save</button><button class="btn ghost" data-s="test-ai">Test connection</button>${ai.key ? '<button class="btn danger" data-s="clear-ai">Remove key</button>' : ''}</div>
      <p class="small" data-aistatus></p>
    </div>
    <div class="card"><div class="steplabel">Privacy</div>
      <ul class="tight small">
        <li><strong>What goes to the AI:</strong> the text of what you say or type in a guided session, the question you’re on, and the entries so far. It goes straight from this device to ${esc(p.name)} using your key. No server of ours is involved.</li>
        <li><strong>What never leaves:</strong> your session recordings, history and backups stay on this device. Only if you use Record &amp; Transcribe is each short spoken answer sent to the transcription service you chose, then discarded by this app.</li>
        <li><strong>Speech-to-text:</strong> on iPhone, listening uses Apple’s speech recognition, which may process audio on the device or on Apple’s servers. Keyboard dictation works the same way.</li>
        <li><strong>Your key</strong> is stored only in this browser on this device and is not included in exports. Anyone with this unlocked phone could use it, so set a spending limit with the provider.</li>
        <li>The provider’s own API data policy applies. Check it in their console; OpenAI and Anthropic say API data isn’t used for training by default.</li>
      </ul></div>
    <div class="card"><div class="steplabel">Voice</div>
      <div class="checklist">
        <label><input type="checkbox" data-voice="speak" ${v.speak ? 'checked' : ''}><span>Speak questions aloud</span></label>
        <label><input type="checkbox" data-voice="autoSend" ${v.autoSend ? 'checked' : ''}><span>Send automatically when I pause</span></label>
      </div>
      <label class="field" for="pauseSec">Pause length before sending (seconds)</label>
      <input type="number" id="pauseSec" min="2" max="15" value="${v.pauseSec}" data-voicenum="pauseSec">
      <label class="field" for="rate">Speaking speed</label>
      <input type="number" id="rate" min="0.6" max="1.6" step="0.1" value="${v.rate}" data-voicenum="rate">
    </div>
    <div class="card"><div class="steplabel">Voice input (Talk button)</div>
      ${(() => { const r = resolveStt(ai, v); const pick = v.stt || 'auto'; const opt = (val, label) => `<option value="${val}" ${pick === val ? 'selected' : ''}>${label}</option>`;
        return `<select id="sttSel" class="select">${opt('auto', 'Automatic (recommended)')}${opt('browser', 'Browser live transcription')}${opt('openai', 'Record &amp; Transcribe with OpenAI')}${opt('xai', 'Record &amp; Transcribe with xAI (Grok)')}${opt('local', 'Record &amp; Transcribe with my server')}${opt('keyboard', 'Keyboard dictation only')}</select>
        <p class="small mt8">On this device the Talk button uses: <strong data-sttnow>${esc(r.label)}</strong>${r.problem ? ` <span class="warnline">(${esc(r.problem)})</span>` : ''}</p>
        ${(pick === 'openai' && !ai.keys.openai) || (pick === 'xai' && !ai.keys.xai) ? `<label class="field" for="sttKey">${pick === 'openai' ? 'OpenAI' : 'xAI'} key for transcription</label><input type="password" id="sttKey" placeholder="Paste key" autocomplete="off" autocapitalize="off" spellcheck="false"><div class="row mt8"><button class="btn quiet" data-s="save-sttkey" data-prov2="${pick}">Save key</button></div>` : ''}
        ${pick === 'local' ? `<label class="field" for="sttBase">Transcription server URL</label><input type="url" id="sttBase" value="${esc(v.sttBase || '')}" placeholder="https://your-pc.your-tailnet.ts.net" autocomplete="off" autocapitalize="off" spellcheck="false">
          <label class="field" for="sttModel">Transcription model</label><input type="text" id="sttModel" value="${esc(v.sttModel || '')}" placeholder="whisper-1 (or your server’s model name)" autocomplete="off" autocapitalize="off" spellcheck="false">
          <p class="muted small">Any OpenAI-compatible <code>/v1/audio/transcriptions</code> server (for example Speaches / faster-whisper-server) behind https, allowing this site in CORS. Ollama itself doesn’t transcribe audio.</p>
          <div class="row mt8"><button class="btn quiet" data-s="save-stt">Save</button></div>` : ''}
        <p class="muted small">Record &amp; Transcribe records your answer, then sends that short clip to the service you chose to turn it into text (about $0.003 per minute with OpenAI, less with xAI). The clip isn’t kept. Browser live transcription uses Apple’s or Google’s speech service. Keyboard dictation always works: tap the answer box, then the keyboard’s mic.</p>`; })()}
      <div class="row"><button class="btn ghost" data-s="test-voice">Test mic &amp; transcription</button></div>
      <div class="small" data-voicetest></div>
    </div>
    <div class="card"><div class="steplabel">About</div><p class="small muted">Version ${APP_VERSION}. If you don’t see a new feature, close the Home Screen app completely (swipe it away in the app switcher) and open it again.</p></div>`;
  }
  function chosenModel() {
    const sel = $('#aiModelSel'); if (!sel) return '';
    return sel.value === '__custom' ? $('#aiModel').value.trim() : sel.value;
  }
  function deviceDesc() {
    const ua = navigator.userAgent; const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const browser = /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : navigator.brave ? 'Brave' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'this browser';
    return (ios ? (standalone ? 'iPhone/iPad Home Screen app' : 'iPhone/iPad ' + browser) : browser + (standalone ? ' (installed app)' : ''));
  }
  async function testVoice() {
    const out = $('[data-voicetest]'); const lines = [];
    const show = (extra) => { out.innerHTML = `<ul class="tight">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>${extra || ''}`; };
    const ai = await getAI(); const v = await getVoice(); G.voice = v; const r = resolveStt(ai, v);
    lines.push('Device: ' + esc(deviceDesc()) + (window.isSecureContext ? '' : ' · ❌ not a secure (https) page, so the mic is blocked'));
    let blob = null;
    show('<p><strong>Recording 3 seconds… say “testing one two three”.</strong></p>');
    try { const rec = answerRecorder(() => {}); setTimeout(() => rec.stop(), 3500); blob = await rec.promise; lines.push(`✅ Microphone works (${fmtSize(blob ? blob.size : 0)} recorded).`); }
    catch (e) { lines.push('❌ Microphone: ' + esc(e.message) + ' On iPhone: Settings › Apps › Safari › Microphone › Allow, then reopen the app.'); }
    let rt = ['openai', 'xai', 'local'].includes(r.kind) ? r : resolveStt(ai, Object.assign({}, v, { stt: 'auto' }));
    if (!['openai', 'xai', 'local'].includes(rt.kind)) rt = null;
    if (blob && rt) {
      show(`<p>Transcribing with ${esc(rt.label)}…</p>`);
      try { const t = await transcribe(blob, rt); lines.push(t ? `✅ ${esc(rt.label)} works. Heard: “${esc(t)}”` : `⚠️ ${esc(rt.label)} answered but heard no words. Try again closer to the mic.`); }
      catch (e) { lines.push(`❌ ${esc(rt.label)}: ${esc(e.message)}${r.kind !== rt.kind ? ' (select it above and Save first so the page is allowed to reach it)' : ''}`); }
    } else if (!rt) lines.push('ℹ️ Record &amp; Transcribe isn’t set up yet: it needs an OpenAI or xAI key, or your own transcription server.');
    lines.push(SR() ? 'ℹ️ This browser offers live transcription. Tap the button below and speak to test it.' : 'ℹ️ This browser has no live transcription (normal for Firefox, and often for the iPhone Home Screen app).');
    lines.push(`➡️ The Talk button will use: <strong>${esc(r.label)}</strong>${r.kind === 'keyboard' ? '. Tap the answer box, then the microphone on your keyboard.' : '.'}`);
    show(SR() ? '<div class="row mt8"><button class="btn quiet" data-s="test-sr">Test live transcription (tap, then speak)</button></div><p class="small" data-srtest></p>' : '');
  }
  function testSR() { // runs straight from the tap, like the Talk button
    const el = $('[data-srtest]'); stopSpeech();
    const l = listen((t) => { el.textContent = 'Heard: “' + t + '”'; }, (m) => { if (!/Heard/.test(el.textContent)) el.textContent = m; });
    el.textContent = 'Starting…';
    const t = setTimeout(() => l.stop(), 8000);
    l.promise.then((txt) => { clearTimeout(t); el.textContent = txt ? '✅ Live transcription works. Heard: “' + txt + '”' : '⚠️ Live transcription heard nothing.'; })
      .catch((e) => { clearTimeout(t); el.textContent = '❌ Live transcription: ' + e.message + (e.code ? ' (' + e.code + ')' : ''); });
  }
  async function saveVoiceAndSync(patch) {
    const v = Object.assign(await getVoice(), patch); await metaSet('voice', v); G.voice = v;
    if (syncPolicy(await getAI(), v)) return reloadToSettings();
    render();
  }
  async function settingsClick(a, t) {
    const st = $('[data-aistatus]');
    if (a === 'test-voice') return testVoice();
    if (a === 'test-sr') return testSR();
    if (a === 'save-stt') {
      const base = normalizeBase($('#sttBase').value); if (base) { try { baseOrigin(base); } catch (e) { $('[data-voicetest]').textContent = e.message; return; } }
      return saveVoiceAndSync({ sttBase: base, sttModel: $('#sttModel').value.trim() });
    }
    if (a === 'save-sttkey') {
      const key = $('#sttKey').value.trim(); if (!key) return;
      const ai = await getAI(); ai.keys[t.dataset.prov2] = key; await saveAI(ai);
      if (syncPolicy(ai, await getVoice())) return reloadToSettings();
      toast('Saved on this device.'); return render();
    }
    if (a === 'load-models') {
      const ai = await getAI(); const base = normalizeBase($('#aiBase').value);
      if (base !== ai.custom.base) { st.textContent = 'Tap Save first to apply the new server address, then Load models.'; return; }
      if (!base) { st.textContent = 'Enter the server URL and tap Save first.'; return; }
      st.textContent = 'Loading models…';
      try {
        const key = $('#aiKey').value.trim() || ai.keys.custom || ''; const headers = key ? { authorization: 'Bearer ' + key } : {};
        const r = await timedFetch(base + '/models', { headers }, 30000); const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || 'HTTP ' + r.status);
        const ids = (j.data || j.models || []).map((m) => m.id || m.name || m.model).filter(Boolean);
        if (!ids.length) throw new Error('The server returned no models.');
        ai.custom.models = ids; if (!ai.models.custom || !ids.includes(ai.models.custom)) ai.models.custom = ids[0];
        if (key) ai.keys.custom = key;
        await saveAI(ai); await render(); $('[data-aistatus]').textContent = `Loaded ${ids.length} model${ids.length > 1 ? 's' : ''}.`;
      } catch (e) { st.textContent = 'Couldn’t load models: ' + (e.message === 'Failed to fetch' || e.name === 'TypeError' ? 'the server didn’t answer, isn’t https, or doesn’t allow this site (CORS).' : e.message); }
      return;
    }
    if (a === 'save-ai') {
      const ai = await getAI(); const key = $('#aiKey').value.trim();
      ai.models[ai.provider] = chosenModel(); if (key) ai.keys[ai.provider] = key;
      if (ai.provider === 'custom') { const base = normalizeBase($('#aiBase').value); if (base) { try { baseOrigin(base); } catch (e) { st.textContent = e.message; return; } } ai.custom.base = base; }
      await saveAI(ai); toast('Saved on this device.');
      if (syncPolicy(ai, await getVoice())) return reloadToSettings();
      render();
    } else if (a === 'clear-ai') {
      if (confirm('Remove the ' + PROVIDERS[(await getAI()).provider].name + ' key from this device?')) { const ai = await getAI(); delete ai.keys[ai.provider]; await saveAI(ai); render(); }
    } else if (a === 'test-ai') {
      const key = $('#aiKey').value.trim(); const ai = await getAI();
      ai.models[ai.provider] = chosenModel(); if (key) ai.keys[ai.provider] = key; await saveAI(ai); ai.key = ai.keys[ai.provider] || '';
      if (ai.provider === 'custom') { const base = normalizeBase($('#aiBase').value); if (base !== ai.custom.base) { st.textContent = 'Tap Save first to apply the new server address.'; return; } if (!base || !ai.models.custom) { st.textContent = 'Add the server URL and a model, then Save.'; return; } }
      if (!configured(ai)) { st.textContent = 'Add a key first.'; return; }
      st.textContent = 'Testing ' + (ai.models[ai.provider] || PROVIDERS[ai.provider].model) + '…' + (ai.provider === 'custom' ? ' A local model can take up to a minute to load the first time.' : '');
      try { const r = await askAI('Reply with JSON only.', 'Return {"ok":true}', (txt) => ({ ok: !!txt, loose: true })); st.textContent = r && r.ok ? (r.loose ? 'Connected. This model doesn’t reply in strict JSON, so entries may be less tidy; the app will cope.' : 'Connected. The AI is ready.') : 'Connected, but the reply was unexpected.'; }
      catch (e) { st.textContent = 'Didn’t work: ' + e.message; }
    }
  }

  // ---------- events ----------
  async function onClick(t) {
    if (t.dataset.prov) { const ai = await getAI(); if (ai.provider !== t.dataset.prov) { ai.provider = t.dataset.prov; await saveAI(ai); syncPolicy(ai, await getVoice()); reloadToSettings(); } return true; }
    if (t.dataset.s) { await settingsClick(t.dataset.s, t); return true; }
    if (t.dataset.gv) {
      const grp = t.closest('[data-gscale]'); const v = +t.dataset.gv;
      $$('button', grp).forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      setField(grp.dataset.gscale, v); saveSoon();
      if (!G.reviewing && cur() && cur().key === grp.dataset.gscale) {
        stopListening(true);
        if (cur().key === 'before.tension' && v >= 4) { G.highTension = true; paint(); } else setTimeout(next, 250);
      }
      return true;
    }
    const g = t.dataset.g; if (!g) return false;
    switch (g) {
      case 'talk': if (G.listener) { G.listener.userDone = true; G.listener.stop(); } else { G.more = false; startVoice(); } break;
      case 'send': { const b = $('#gAnswer'); const txt = b ? b.value : ''; if (G.listener) { stopListening(true); } if (txt.trim()) submit(txt); else if (cur().optional) next(); else toast('Say or type an answer, or tap Skip.'); break; }
      case 'skip': next(); break;
      case 'next': next(); break;
      case 'back': back(); break;
      case 'resume': resume(); break;
      case 'review': G.paused = false; review(); break;
      case 'retry': { G.error = ''; errPaint(); const txt = G.lastText; G.convo.pop(); if (txt) submit(txt); break; }
      case 'asis': { G.error = ''; G.convo.pop(); await handle(cur(), localFill(cur(), G.lastText || '')); break; }
      case 'ground-stop': G.highTension = false; S.session.stoppedEarly = true; saveSoon(); G.idx = G.fields.findIndex((f) => f.key === 'close'); beginField(); break;
      case 'continue-anyway': G.highTension = false; next(); break;
      case 'redo': G.reviewing = false; G.idx = G.fields.findIndex((f) => f.key === t.dataset.key); G.returnToReview = true; beginField(); break;
      case 'save': await saveAll(); break;
      case 'exit':
        stopListening(true); stopSpeech();
        if (G.mode === 'session') { await saveSession(); toast('Saved as unfinished. Resume or finish it from Today.'); S.view = 'home'; }
        else { await saveSession(); S.detailId = S.session.id; S.view = 'detail'; }
        render(); break;
    }
    return true;
  }
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.rfield && S.session && S.view === 'guided') { setField(el.dataset.rfield, el.value); saveSoon(); }
  });
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.id === 'sttSel') { await saveVoiceAndSync({ stt: el.value }); return; }
    if (el.id === 'aiModelSel') { $('#aiModel').classList.toggle('hidden', el.value !== '__custom'); if (el.value === '__custom') $('#aiModel').focus(); }
    if (el.dataset.voice) { const v = await getVoice(); v[el.dataset.voice] = el.checked; await metaSet('voice', v); G.voice = v; }
    if (el.dataset.voicenum) { const v = await getVoice(); const n = parseFloat(el.value); if (n > 0) { v[el.dataset.voicenum] = n; await metaSet('voice', v); G.voice = v; } }
  });
  function leave() { stopListening(true); stopSpeech(); }

  // Keep the connection policy (csp.js reads localStorage) in step with the saved provider.
  Promise.all([getAI(), getVoice()]).then(([ai, v]) => { if (syncPolicy(ai, v)) location.reload(); }).catch(() => {});
  window.Guided = { start, view: viewGuided, after: afterGuided, settingsView: viewSettings, onClick, leave, PROVIDERS, _G: G };
})();
