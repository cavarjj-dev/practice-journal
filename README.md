# Active Imagination Practice Journal

A private, offline-capable web app for a guided active imagination practice: grounding, a starting image, a recorded dialogue, check-ins before and after, a closing ritual, and a separate after-reflection. History, arcs ("continue this image"), and simple tracking over time.

**Privacy by design**
- Everything (sessions, notes, audio) is stored only in the browser's IndexedDB on the device you use.
- No server, no accounts, no analytics, no third-party scripts or fonts. A Content-Security-Policy restricts the page to its own files.
- Backups are files you export yourself (.zip with `journal.json` + audio, or text-only .json) and can import again.
- Clearing the browser's website data deletes the journal. Back up regularly.

**Files**: `index.html`, `styles.css`, `app.js`, `zip.js` (minimal stored-zip writer/reader), `sw.js` (offline cache), `manifest.webmanifest`, `icons/`.

This repository contains code only, no personal data. Not indexed (`noindex` + `robots.txt`).
