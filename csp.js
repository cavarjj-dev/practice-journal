/* Narrows outgoing connections to the AI endpoint (and transcription service) chosen in Settings.
   Adds a second Content-Security-Policy; browsers enforce both, so only this origin (plus the site itself) is reachable. */
(function () {
  var p = 'anthropic', custom = '', stt = '';
  try { p = localStorage.getItem('pj-provider') || 'anthropic'; custom = localStorage.getItem('pj-custom-origin') || ''; stt = localStorage.getItem('pj-stt-origin') || ''; } catch (e) { /* */ }
  var ok = function (o) { return /^(https:\/\/[^\s;'"]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(o); };
  var origin = p === 'custom' ? (ok(custom) ? custom : '')
    : ({ openai: 'https://api.openai.com', xai: 'https://api.x.ai' }[p] || 'https://api.anthropic.com');
  var m = document.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  // the AI provider, plus the transcription service if it's a different one
  var sttOrigin = ok(stt) && stt !== origin ? ' ' + stt : '';
  m.content = "connect-src 'self'" + (origin ? ' ' + origin : '') + sttOrigin;
  document.head.appendChild(m);
})();
