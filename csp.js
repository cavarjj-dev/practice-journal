/* Narrows outgoing connections to the one AI endpoint chosen in Settings.
   Adds a second Content-Security-Policy; browsers enforce both, so only this origin (plus the site itself) is reachable. */
(function () {
  var p = 'anthropic', custom = '';
  try { p = localStorage.getItem('pj-provider') || 'anthropic'; custom = localStorage.getItem('pj-custom-origin') || ''; } catch (e) { /* */ }
  var origin = p === 'custom' ? (/^(https:\/\/[^\s;'"]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(custom) ? custom : '')
    : ({ openai: 'https://api.openai.com', xai: 'https://api.x.ai' }[p] || 'https://api.anthropic.com');
  var m = document.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = "connect-src 'self'" + (origin ? ' ' + origin : '');
  document.head.appendChild(m);
})();
