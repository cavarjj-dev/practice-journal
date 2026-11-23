/* Guided session: speaks each template question, listens, and (optionally) uses an AI model
   the user chooses, with the user's own key, to write concise entries and ask follow-ups.
   Relies on helpers defined in app.js ($, esc, S, dbPut, metaGet, ...), used at call time. */
(function () {
  'use strict';

  // ---------- providers ----------
  const PROVIDERS = {
    anthropic: {
      name: 'Anthropic (Claude)', origin: 'https://api.anthropic.com', model: 'claude-haiku-5-5',
      keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'starts with sk-ant-',
      async call(cfg, system, user) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
          body: JSON.stringify({ model: cfg.model, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
        return (j.content || []).map((c) => c.text || '').join('');
      },
    },
    openai: {
      name: 'OpenAI', origin: 'https://api.openai.com', model: 'gpt-5.4-mini',
      keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'starts with sk-',
      async call(cfg, system, user) {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
          body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' } }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
        return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      },
    },
  };
  const DEFAULT_AI = { provider: 'anthropic', model: '', key: '' };
  const DEFAULT_VOICE = { speak: true, rate: 1, autoSend: true, pauseSec: 4, lang: '' };
  async function getAI() { return Object.assign({}, DEFAULT_AI, await metaGet('ai', {})); }
  async function getVoice() { return Object.assign({}, DEFAULT_VOICE, await metaGet('voice', {})); }
  function parseJSON(text) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) throw new Error('The AI reply wasn’t readable.');
    return JSON.parse(m[0]);
  }
  async function askAI(system, user) {
    const cfg = await getAI();
    const p = PROVIDERS[cfg.provider] || PROVIDERS.anthropic;
    if (!cfg.key) return null;
    return parseJSON(await p.call({ key: cfg.key, model: cfg.model || p.model }, system, user));
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
        setTimeout(fin, 2000 + text.length * 85 / (G.voice.rate || 1));
        speechSynthesis.speak(u);
      } catch (e) { fin(); }
    });
  }
  function stopSpeech() { try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* */ } }
  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen(onText) {
    let rec, resolveFn, rejectFn, finalText = '', interim = '', got = false, silenceT, watchT, settled = false;
    const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    const settle = (fn, v) => { if (settled) return; settled = true; clearTimeout(silenceT); clearTimeout(watchT); fn(v); };
    const Ctor = SR();
    if (!Ctor || G.srBroken) { settle(rejectFn, new Error('unsupported')); return { promise: p, stop() {} }; }
    try {
      rec = new Ctor();
      rec.continuous = true; rec.interimResults = true; rec.lang = G.voice.lang || navigator.language || 'en-US';
      rec.onresult = (e) => {
        got = true; interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t.trim() + ' '; else interim += t; }
        onText((finalText + interim).trim());
        clearTimeout(silenceT);
        if (G.voice.autoSend) silenceT = setTimeout(() => { try { rec.stop(); } catch (er) { /* */ } }, (G.voice.pauseSec || 4) * 1000 * (cur() && cur().type === 'append' ? 1.75 : 1));
      };
      rec.onerror = (e) => {
        if (e.error === 'aborted') return;
        if (e.error === 'no-speech' && got) return;
        settle(rejectFn, new Error(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'denied' : e.error === 'no-speech' ? 'silent' : e.error || 'error'));
        try { rec.abort(); } catch (er) { /* */ }
      };
      rec.onend = () => settle(resolveFn, (finalText + interim).trim());
      watchT = setTimeout(() => { if (!got) { settle(rejectFn, new Error('silent')); try { rec.abort(); } catch (er) { /* */ } } }, 9000);
      rec.start();
    } catch (e) { settle(rejectFn, new Error('unsupported')); }
    return { promise: p, stop() { try { rec && rec.stop(); } catch (e) { /* */ } } };
  }
  function stopListening(discard) { if (G.listener) { const l = G.listener; G.listener = null; if (discard) l.discard = true; l.stop(); } }

  // ---------- flow ----------
  async function start(mode, fromId) {
    if (S.rec && S.rec.state !== 'idle') { await stopActiveRecording(); toast('Audio recording stopped and saved. Guided mode uses the microphone for talking.'); }
    G.voice = await getVoice(); G.hasKey = !!(await getAI()).key;
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
    if (f.type !== 'info') startListening();
  }
  function startListening() {
    if (G.listener || G.paused) return;
    stopSpeech();
    const box = $('#gAnswer'); if (!box) return;
    G.base = box.value ? box.value.trim() + ' ' : '';
    const l = listen((t) => { const b = $('#gAnswer'); if (b) b.value = G.base + t; });
    G.listener = l; G.state = 'listening'; G.tip = ''; status(); tipPaint();
    l.promise.then((text) => {
      if (G.listener === l) G.listener = null;
      G.state = 'idle'; status();
      if (l.discard) return;
      const b = $('#gAnswer'); const all = b ? b.value.trim() : text;
      if (all) submit(all);
    }).catch((err) => {
      if (G.listener === l) G.listener = null;
      G.state = 'idle'; status();
      if (l.discard) return;
      if (err.message !== 'error') G.srBroken = true;
      G.tip = err.message === 'denied'
        ? 'Speech recognition isn’t allowed. Tap the answer box, then tap the microphone on your keyboard to dictate, and tap Send.'
        : 'Voice listening isn’t working here. Tap the answer box, then tap the microphone on your keyboard to dictate, and tap Send.';
      tipPaint();
    });
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
      try { r = await askAI(SYSTEM + (f.type === 'append' ? '\n' + DIALOGUE_RULE : ''), fieldPrompt(f)); }
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
      if (S.view === 'guided' && cur() === f && !G.paused) startListening();
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
      if (S.view === 'guided' && cur() === f && !G.paused) startListening();
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
        const r = await askAI(`You review a completed journal entry for Julian's active imagination practice. Check each required field against what it needs. Flag only real gaps: empty, too vague to be useful, or missing a required part (for example an action without a deadline). Do not judge or interpret content. Do not flag optional fields. Reply with JSON only: {"gaps":[{"key":"<field key>","issue":"<under 15 words>"}],"say":"<one short spoken sentence>"}`, JSON.stringify(values));
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
        <div class="recstate" data-gstatus></div>
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
  function status() {
    const el = $('[data-gstatus]'); const b = $('.talkbtn');
    if (!el) return;
    const map = { listening: '● Listening… pause or tap Talk to finish', thinking: 'Writing it up…', speaking: 'Speaking…', idle: G.srBroken ? 'Type or use the keyboard mic, then tap Send.' : 'Tap Talk to answer.' };
    el.textContent = map[G.state] || '';
    if (b) { b.classList.toggle('recording', G.state === 'listening'); b.textContent = G.state === 'listening' ? 'Done' : 'Talk'; b.disabled = G.state === 'thinking'; }
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
    const srOk = !!SR();
    return `<h1>Settings</h1>
    <div class="card"><div class="steplabel">AI for guided sessions</div>
      <label class="field" for="aiProv">Provider</label>
      <div class="chips">${Object.entries(PROVIDERS).map(([k, x]) => `<button class="chip" data-prov="${k}" aria-pressed="${ai.provider === k}">${esc(x.name)}</button>`).join('')}</div>
      <label class="field" for="aiModel">Model</label>
      <input type="text" id="aiModel" value="${esc(ai.model)}" placeholder="${esc(p.model)} (default)" autocomplete="off" autocapitalize="off" spellcheck="false">
      <label class="field" for="aiKey">API key</label>
      <input type="password" id="aiKey" value="" placeholder="${ai.key ? 'Key saved on this device (•••• ' + esc(ai.key.slice(-4)) + ')' : 'Paste your key (' + esc(p.keyHint) + ')'}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <p class="muted small">Get a key at <a href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">${esc(p.keyUrl.replace('https://', ''))}</a>.</p>
      <div class="row"><button class="btn" data-s="save-ai">Save</button><button class="btn ghost" data-s="test-ai">Test connection</button>${ai.key ? '<button class="btn danger" data-s="clear-ai">Remove key</button>' : ''}</div>
      <p class="small" data-aistatus></p>
    </div>
    <div class="card"><div class="steplabel">Privacy</div>
      <ul class="tight small">
        <li><strong>What goes to the AI:</strong> the text of what you say or type in a guided session, the question you’re on, and the entries so far. It goes straight from this device to ${esc(p.name)} using your key. No server of ours is involved.</li>
        <li><strong>What never leaves:</strong> audio recordings, your history, and your backups stay on this device.</li>
        <li><strong>Speech-to-text:</strong> on iPhone, listening uses Apple’s speech recognition, which may process audio on the device or on Apple’s servers. Keyboard dictation works the same way.</li>
        <li><strong>Your key</strong> is stored only in this browser on this device and is not included in exports. Anyone with this unlocked phone could use it, so set a spending limit with the provider.</li>
        <li>The provider’s API data policy applies; both OpenAI and Anthropic say API data isn’t used for training by default.</li>
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
      <p class="muted small">Listening in this browser: ${srOk ? 'available. If it stops responding on iPhone, the app switches to the keyboard microphone.' : 'not available. Use the microphone on your keyboard to dictate into the answer box.'}</p>
    </div>
    <div class="card"><div class="steplabel">About</div><p class="small muted">Version ${APP_VERSION}. If you don’t see a new feature, close the Home Screen app completely (swipe it away in the app switcher) and open it again.</p></div>`;
  }
  async function settingsClick(a) {
    const st = $('[data-aistatus]');
    if (a === 'save-ai') {
      const ai = await getAI(); const key = $('#aiKey').value.trim();
      ai.model = $('#aiModel').value.trim(); if (key) ai.key = key;
      await metaSet('ai', ai); toast('Saved on this device.'); render();
    } else if (a === 'clear-ai') {
      if (confirm('Remove the API key from this device?')) { const ai = await getAI(); ai.key = ''; await metaSet('ai', ai); render(); }
    } else if (a === 'test-ai') {
      const key = $('#aiKey').value.trim(); const ai = await getAI();
      if (key) { ai.key = key; ai.model = $('#aiModel').value.trim(); await metaSet('ai', ai); }
      if (!ai.key) { st.textContent = 'Add a key first.'; return; }
      st.textContent = 'Testing…';
      try { const r = await askAI('Reply with JSON only.', 'Return {"ok":true}'); st.textContent = r && r.ok ? 'Connected. The AI is ready.' : 'Connected, but the reply was unexpected.'; }
      catch (e) { st.textContent = 'Didn’t work: ' + e.message; }
    }
  }

  // ---------- events ----------
  async function onClick(t) {
    if (t.dataset.prov) { const ai = await getAI(); if (ai.provider !== t.dataset.prov) { ai.provider = t.dataset.prov; ai.model = ''; ai.key = ''; await metaSet('ai', ai); try { localStorage.setItem('pj-provider', ai.provider); } catch (e) { /* */ } try { sessionStorage.setItem('pj-view', 'settings'); } catch (e) { /* */ } location.reload(); } return true; }
    if (t.dataset.s) { await settingsClick(t.dataset.s); return true; }
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
      case 'talk': if (G.listener) G.listener.stop(); else { G.more = false; startListening(); } break;
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
    if (el.dataset.voice) { const v = await getVoice(); v[el.dataset.voice] = el.checked; await metaSet('voice', v); G.voice = v; }
    if (el.dataset.voicenum) { const v = await getVoice(); const n = parseFloat(el.value); if (n > 0) { v[el.dataset.voicenum] = n; await metaSet('voice', v); G.voice = v; } }
  });
  function leave() { stopListening(true); stopSpeech(); }

  window.Guided = { start, view: viewGuided, after: afterGuided, settingsView: viewSettings, onClick, leave, PROVIDERS, _G: G };
})();
