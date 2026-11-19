// Shared by the landing page and the docs. Loaded in <head> without defer, so
// the theme and language are set before the first paint; the rest waits for
// the DOM. Everything works without it: the pages are plain HTML in Chinese.
(function () {
  'use strict';
  var root = document.documentElement;
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Language: a saved choice, else Chinese for zh* and English otherwise (like the app).
  function initialLang() {
    var saved = store.get('honk-lang');
    if (saved === 'zh' || saved === 'en') return saved;
    var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'zh'];
    return /^zh/i.test(langs[0] || '') ? 'zh' : 'en';
  }
  function applyLang(lang) {
    root.setAttribute('data-lang', lang);
    root.lang = lang === 'zh' ? 'zh-CN' : 'en';
    var t = root.getAttribute('data-title-' + lang);
    if (t) document.title = t;
    var nodes = document.querySelectorAll('[data-ph-' + lang + ']');
    for (var i = 0; i < nodes.length; i++) nodes[i].setAttribute('placeholder', nodes[i].getAttribute('data-ph-' + lang));
    document.dispatchEvent(new CustomEvent('honk:lang', { detail: lang }));
  }

  // Theme: a saved choice wins over the system's; data-theme-now is what is shown.
  function applyTheme() {
    var saved = store.get('honk-theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
    else root.removeAttribute('data-theme');
    var now = saved === 'light' || saved === 'dark' ? saved : darkQuery && darkQuery.matches ? 'dark' : 'light';
    root.setAttribute('data-theme-now', now);
  }

  applyTheme();
  applyLang(initialLang());
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', applyTheme);

  window.Honk = { store: store, reduced: reduced, lang: function () { return root.getAttribute('data-lang') || 'zh'; } };

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    applyLang(window.Honk.lang()); // placeholders and the title now exist

    var langBtn = document.querySelector('.lang-btn');
    if (langBtn) langBtn.addEventListener('click', function () {
      var next = window.Honk.lang() === 'zh' ? 'en' : 'zh';
      store.set('honk-lang', next);
      applyLang(next);
    });
    var themeBtn = document.querySelector('.theme-btn');
    // Switches to the other theme; landing on the system's own choice forgets
    // the override, so the page follows the system again.
    if (themeBtn) themeBtn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme-now') === 'dark' ? 'light' : 'dark';
      var system = darkQuery && darkQuery.matches ? 'dark' : 'light';
      if (next === system) store.del('honk-theme');
      else store.set('honk-theme', next);
      applyTheme();
    });

    // Snippets show this gateway's own address.
    var origin = location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : 'https://honk.example.com';
    var spots = document.querySelectorAll('.origin');
    for (var i = 0; i < spots.length; i++) spots[i].textContent = origin;
    var hosts = document.querySelectorAll('.host');
    for (var j = 0; j < hosts.length; j++) hosts[j].textContent = location.host || 'honk.example.com';

    initTabs();
    initNav();
    initReveal();
  });

  // Tab lists: [role=tablist] with [role=tab][aria-controls]; panels are hidden when not chosen.
  function initTabs() {
    var lists = document.querySelectorAll('[role=tablist][data-tabs]');
    for (var i = 0; i < lists.length; i++) (function (list) {
      var tabs = list.querySelectorAll('[role=tab]');
      function pick(tab, focus) {
        for (var k = 0; k < tabs.length; k++) {
          var on = tabs[k] === tab;
          tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
          tabs[k].tabIndex = on ? 0 : -1;
          var panel = document.getElementById(tabs[k].getAttribute('aria-controls'));
          if (panel) panel.hidden = !on;
        }
        if (focus) tab.focus();
      }
      for (var k = 0; k < tabs.length; k++) (function (tab, idx) {
        tab.addEventListener('click', function () { pick(tab, false); });
        tab.addEventListener('keydown', function (e) {
          var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          pick(tabs[(idx + d + tabs.length) % tabs.length], true);
        });
      })(tabs[k], k);
    })(lists[i]);
  }

  // The pill nav: solid once scrolled, hidden while reading down past the first screen,
  // with hysteresis so jittery scrolling never flips it back and forth.
  function initNav() {
    var shell = document.querySelector('.nav-shell');
    var nav = shell && shell.querySelector('.nav');
    if (!nav) return;
    var hides = shell.hasAttribute('data-autohide');
    var fold = window.innerHeight * 0.8, width = window.innerWidth;
    var scrolled = false, hidden = false, turn = window.scrollY, frame = 0;
    function update() {
      frame = 0;
      var y = Math.max(0, window.scrollY);
      if (hides) {
        if (!hidden) {
          turn = Math.min(turn, y);
          if (y > fold && y - turn >= 24) { hidden = true; turn = y; }
        } else {
          turn = Math.max(turn, y);
          if (y <= fold || turn - y >= 12) { hidden = false; turn = y; }
        }
      }
      if (!scrolled && y > 12) scrolled = true;
      else if (scrolled && y < 4) scrolled = false;
      nav.classList.toggle('scrolled', scrolled);
      shell.classList.toggle('is-hidden', hidden);
    }
    window.addEventListener('scroll', function () { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
    window.addEventListener('resize', function () {
      if (window.innerWidth !== width) { width = window.innerWidth; fold = window.innerHeight * 0.8; }
    }, { passive: true });
    // A link into the page shows the nav again.
    shell.addEventListener('focusin', function () { hidden = false; shell.classList.remove('is-hidden'); });
    update();
  }

  // Adds .in to each .reveal once it scrolls into view; sections stay visible without JS.
  function initReveal() {
    var nodes = document.querySelectorAll('.reveal');
    if (!nodes.length || reduced || !('IntersectionObserver' in window)) return;
    document.body.classList.add('motion-ready');
    var io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) continue;
        entries[i].target.classList.add('in');
        io.unobserve(entries[i].target);
      }
    }, { rootMargin: '0px 0px -10% 0px' });
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], sibs = n.parentElement ? n.parentElement.children : [], idx = 0;
      for (var k = 0; k < sibs.length && sibs[k] !== n; k++) if (sibs[k].classList.contains('reveal')) idx++;
      n.style.setProperty('--reveal-i', String(idx));
      io.observe(n);
    }
  }
})();
