// The docs page: sidebar search, the section being read, the jump menu on
// narrow screens and the copy buttons. Tabs come from site.js.
(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var nav = document.getElementById('docs-nav');
    var links = nav ? Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]')) : [];
    var sections = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });

    // Search: matches the link's text in both languages, its keywords and the
    // section's text. Non-matching links and sections are hidden.
    var q = document.getElementById('docs-q');
    var empty = nav && nav.querySelector('.empty');
    var noMatch = document.getElementById('no-match');
    function filter() {
      var term = (q.value || '').trim().toLowerCase();
      var shown = 0;
      links.forEach(function (a, i) {
        var sec = sections[i];
        var hay = (a.textContent + ' ' + (a.getAttribute('data-k') || '') + ' ' + (term.length > 2 && sec ? sec.textContent : '')).toLowerCase();
        var on = !term || hay.indexOf(term) >= 0;
        a.hidden = !on;
        if (sec) sec.hidden = !on;
        if (on) shown++;
      });
      var groups = nav.querySelectorAll('.grp');
      for (var g = 0; g < groups.length; g++) groups[g].hidden = !groups[g].querySelector('a:not([hidden])');
      if (empty) empty.hidden = shown > 0;
      if (noMatch) noMatch.style.display = shown > 0 ? 'none' : 'block';
    }
    if (q && nav) {
      q.addEventListener('input', filter);
      q.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var first = nav.querySelector('a:not([hidden])');
          if (first) { e.preventDefault(); location.hash = first.getAttribute('href'); }
        } else if (e.key === 'Escape') {
          q.value = '';
          filter();
        }
      });
      // "/" focuses the search, as on most docs sites.
      document.addEventListener('keydown', function (e) {
        if (e.key === '/' && document.activeElement !== q && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
          e.preventDefault();
          q.focus();
        }
      });
    }

    // Jump menu for narrow screens, built from the sidebar in the current language.
    var jump = document.getElementById('docs-jump');
    function buildJump() {
      if (!jump || !nav) return;
      var lang = window.Honk ? window.Honk.lang() : 'zh';
      jump.textContent = '';
      var groups = nav.querySelectorAll('.grp');
      for (var g = 0; g < groups.length; g++) {
        var label = groups[g].querySelector(':scope > span');
        var og = document.createElement('optgroup');
        og.label = textIn(label, lang);
        var as = groups[g].querySelectorAll('a');
        for (var k = 0; k < as.length; k++) {
          var opt = document.createElement('option');
          opt.value = as[k].getAttribute('href');
          opt.textContent = textIn(as[k], lang);
          og.appendChild(opt);
        }
        jump.appendChild(og);
      }
      if (current) jump.value = '#' + current;
    }
    // The visible text of a node in one language (the other language's spans skipped).
    function textIn(node, lang) {
      var other = lang === 'zh' ? 'en' : 'zh';
      var out = '';
      (function walk(n) {
        for (var c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) out += c.nodeValue;
          else if (c.nodeType === 1 && !c.classList.contains(other) && !c.classList.contains('verb')) walk(c);
        }
      })(node);
      return out.replace(/\s+/g, ' ').trim();
    }
    if (jump) jump.addEventListener('change', function () { location.hash = jump.value; });
    document.addEventListener('honk:lang', buildJump);

    // The section being read: the last one whose top has passed under the nav.
    var current = '';
    var frame = 0;
    function spy() {
      frame = 0;
      var id = '';
      for (var i = 0; i < sections.length; i++) {
        var s = sections[i];
        if (!s || s.hidden) continue;
        if (s.getBoundingClientRect().top <= 120) id = s.id;
      }
      if (!id && sections[0]) id = sections[0].id;
      if (id === current) return;
      current = id;
      links.forEach(function (a) {
        if (a.getAttribute('href') === '#' + id) {
          a.setAttribute('aria-current', 'true');
          // Keep it in view inside the sidebar without moving the page.
          var box = nav.getBoundingClientRect(), r = a.getBoundingClientRect();
          if (r.top < box.top || r.bottom > box.bottom) nav.scrollTop += r.top - box.top - box.height / 2;
        } else a.removeAttribute('aria-current');
      });
      if (jump) jump.value = '#' + id;
    }
    window.addEventListener('scroll', function () { if (!frame) frame = requestAnimationFrame(spy); }, { passive: true });
    spy();
    buildJump();

    // Copy buttons copy the visible code of their block.
    var copies = document.querySelectorAll('.code .copy');
    for (var c = 0; c < copies.length; c++) (function (btn) {
      var label = btn.innerHTML;
      btn.addEventListener('click', function () {
        var block = btn.closest('.code');
        var pres = block.querySelectorAll('pre');
        var pre = null;
        for (var i = 0; i < pres.length; i++) if (!pres[i].hidden) { pre = pres[i]; break; }
        if (!pre) return;
        var text = pre.textContent;
        var done = function () {
          btn.innerHTML = '<svg class="i" aria-hidden="true"><use href="#i-check"/></svg><span class="zh">已复制</span><span class="en">Copied</span>';
          setTimeout(function () { btn.innerHTML = label; }, 1600);
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
        else { fallback(text); done(); }
      });
    })(copies[c]);
    function fallback(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'sr';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
      document.body.removeChild(ta);
    }
  });
})();
