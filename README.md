# Active Imagination Practice Journal

A private, offline-capable web app for a guided active imagination practice: grounding, a starting image, a recorded dialogue, check-ins before and after, a closing ritual, and a separate after-reflection. History, arcs ("continue this image"), and simple tracking over time.

**Privacy by design**
- Everything (sessions, notes, audio) is stored only in the browser's IndexedDB on the device you use.
- No server, no accounts, no analytics, no third-party scripts or fonts. A Content-Security-Policy restricts the page to its own files.
- Backups are files you export yourself (.zip with `journal.json` + audio, or text-only .json) and can import again.
- Clearing the browser's website data deletes the journal. Back up regularly.

**Guided session (optional AI)**
- Speaks each template question (speechSynthesis). Tap **Talk** to answer: live browser transcription (Web Speech API), or **Record & Transcribe** (records the answer, then sends just that clip to OpenAI `gpt-4o-mini-transcribe`, xAI `/v1/stt`, or your own OpenAI-compatible `/audio/transcriptions` server), with keyboard dictation as the fallback. Settings › Voice input chooses the method and has a **Test mic & transcription** button. It can also use an AI model to turn spoken answers into concise entries, ask follow-ups, and review for gaps before saving.
- No server of ours: providers are Anthropic, OpenAI, xAI (Grok), or a local/custom OpenAI-compatible server (e.g. Ollama behind Tailscale Serve, LM Studio). Keys are stored per provider only in this browser (IndexedDB) and never exported. Requests go directly from the browser to the chosen endpoint; `csp.js` narrows `connect-src` to exactly that origin.
- Only text is sent to the AI. Audio recordings never leave the device.

**Files**: `index.html`, `styles.css`, `app.js`, `zip.js` (minimal stored-zip writer/reader), `guided.js` (guided session, AI providers, settings), `csp.js` (per-provider connect-src), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.

This repository contains code only, no personal data. Not indexed (`noindex` + `robots.txt`).
