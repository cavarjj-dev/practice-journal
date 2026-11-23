/* Narrows outgoing connections to the one AI provider chosen in Settings.
   Adds a second Content-Security-Policy; browsers enforce both, so only this origin (plus the site itself) is reachable. */
(function () {
  var p = 'anthropic';
  try { p = localStorage.getItem('pj-provider') || 'anthropic'; } catch (e) { /* */ }
  var origin = p === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com';
  var m = document.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = "connect-src 'self' " + origin;
  document.head.appendChild(m);
})();
