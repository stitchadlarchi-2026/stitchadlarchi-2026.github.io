// STITCH usage beacon. nginx adds this to every HTML page it serves (see
// deploy/nginx.conf), so the page itself never has to carry it and Breeze can
// rewrite index.html freely. It sends one word per event and nothing else: no
// cookie, no storage, no identifier, no URL, no text from the page.
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
})();
