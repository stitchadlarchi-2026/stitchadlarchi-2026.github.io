// STITCH usage beacon. nginx adds this to every HTML page it serves (see
// deploy/nginx.conf), so the page itself never has to carry it and Breeze can
// rewrite index.html freely. It sends one word per event and nothing else: no
// cookie, no storage, no identifier, no URL, no text from the page. (The
// heartbeat at the bottom is separate: see there.)
//
// It reads what was clicked by what it already is: an in-page link is a
// section, data-tab and data-tier are the Info tabs and sponsor tiers, a
// button with an id is an action, a link off the site is its host. A new
// element of one of those kinds is counted without anyone editing this file.
(function () {
  function send(name) {
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/_u/e', name)) return;
      fetch('/_u/e', { method: 'POST', body: name, keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  function slug(s) {
    return String(s)
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  function nameOf(el) {
    var t = el.closest('[data-tab]');
    if (t) return 'tab:' + slug(t.getAttribute('data-tab'));
    t = el.closest('[data-tier]');
    if (t) return 'tier:' + slug(t.getAttribute('data-tier'));
    var a = el.closest('a[href]');
    if (a) {
      var href = a.getAttribute('href');
      if (href.charAt(0) === '#') return href.length > 1 ? 'nav:' + slug(href.slice(1)) : null;
      if (/^mailto:/i.test(href)) return 'action:mailto';
      if (a.host && a.host !== location.host) return 'link:' + slug(a.hostname.replace(/^www\./, ''));
      return null;
    }
    var b = el.closest('button[id]');
    if (b) return 'action:' + slug(b.id);
    return null;
  }

  document.addEventListener(
    'click',
    function (e) {
      if (!(e.target instanceof Element)) return;
      var name = nameOf(e.target);
      if (name && !/:$/.test(name)) send(name);
    },
    true,
  );

  send('view');

  // The live view in the admin console: every 20 seconds while the tab is
  // open, which page it is on and whether the form is being filled in or is
  // uploading. The id is random, made fresh on each page load and held only
  // in this variable: never stored, never sent anywhere else. The service
  // keeps it in memory for under a minute.
  var id = '';
  try {
    id = crypto.getRandomValues(new Uint32Array(3)).join('-').replace(/[^0-9-]/g, '').slice(0, 40);
  } catch (e) {
    id = String(Math.random()).slice(2, 14) + '-' + Date.now();
  }
  var last = '';
  function shown(el) {
    return !!el && !el.hidden && !el.closest('[hidden]');
  }
  function state() {
    var page = (location.hash.replace(/^#/, '').split('/')[0] || 'home').toLowerCase();
    if (!/^(home|info|links|directory|sponsors)$/.test(page)) page = 'other';
    var act = 'browsing';
    if (shown(document.getElementById('xProgress'))) act = 'uploading';
    else if (shown(document.getElementById('xDone'))) act = 'submitted';
    else {
      var form = document.getElementById('xForm');
      if (form && page === 'links') {
        var body = document.getElementById('xhbBody');
        var open = body && !body.inert;
        var typed = form.querySelector('input[name="name"]');
        if (open && ((typed && typed.value) || form.contains(document.activeElement))) act = 'form';
      }
    }
    return page + ' ' + act;
  }
  function beat(force) {
    if (document.visibilityState === 'hidden') return;
    var s = state();
    if (!force && s === last) return;
    last = s;
    try {
      fetch('/_s/ping', { method: 'POST', body: id + ' ' + s, keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  setInterval(function () { beat(true); }, 20000);
  setInterval(function () { beat(false); }, 2000);
  document.addEventListener('visibilitychange', function () { beat(true); });
  addEventListener('pagehide', function () {
    try {
      navigator.sendBeacon('/_s/ping', id + ' ' + state().split(' ')[0] + ' gone');
    } catch (e) {}
  });
  beat(true);
})();
