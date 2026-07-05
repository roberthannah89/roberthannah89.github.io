/*
 * Command-center menu dropdown.
 *
 * Wires the top-left ☰ button (#nav-menu-btn, rendered inline in the filter
 * bar) to a floating panel that lists the site-consistent horizontal guide
 * nav — Hikes · Command center · Planning · Trails & grades · Weather · Gear.
 * Data comes from window.HikesNav (published by ../guides/_nav.js) so adding
 * or reordering a guide propagates here automatically.
 */
(function () {
  var btn = document.getElementById('nav-menu-btn');
  if (!btn || !window.HikesNav || !window.HikesNav.buildLinksHTML) return;

  var panel = document.createElement('nav');
  panel.id = 'nav-panel';
  panel.className = 'guide-nav';
  panel.hidden = true;
  panel.innerHTML = window.HikesNav.buildLinksHTML();
  document.body.appendChild(panel);

  function open() {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('open');
  }
  function close() {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    btn.classList.remove('open');
  }
  function toggle() {
    if (panel.hidden) open(); else close();
  }

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggle();
  });
  panel.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { if (!panel.hidden) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) close();
  });
})();
