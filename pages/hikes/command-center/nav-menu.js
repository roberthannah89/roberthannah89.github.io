/*
 * Command-center menu pill.
 *
 * Reads window.HikesNav (published by guides/_nav.js) and injects a small
 * top-right pill that reveals the site-consistent horizontal nav strip on
 * click. Keeps the map full-bleed by default while giving one-click access
 * to Hikes, Command center, Planning, Trails & grades, Weather, Gear.
 */
(function () {
  if (!window.HikesNav || !window.HikesNav.buildLinksHTML) return;

  var pill = document.createElement('button');
  pill.id = 'nav-pill';
  pill.type = 'button';
  pill.setAttribute('aria-label', 'Site menu');
  pill.setAttribute('aria-expanded', 'false');
  pill.innerHTML = '<span class="nav-pill-icon" aria-hidden="true">☰</span><span class="nav-pill-label">Menu</span>';

  var panel = document.createElement('nav');
  panel.id = 'nav-panel';
  panel.className = 'guide-nav';
  panel.hidden = true;
  panel.innerHTML = window.HikesNav.buildLinksHTML();

  document.body.appendChild(pill);
  document.body.appendChild(panel);

  function open() {
    panel.hidden = false;
    pill.setAttribute('aria-expanded', 'true');
    pill.classList.add('open');
  }
  function close() {
    panel.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    pill.classList.remove('open');
  }
  function toggle() {
    if (panel.hidden) open(); else close();
  }

  pill.addEventListener('click', function (e) {
    e.stopPropagation();
    toggle();
  });
  panel.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('click', function () { if (!panel.hidden) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) close();
  });
})();
