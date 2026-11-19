// The landing page's moving parts: the hero's send demo, the message journey
// and the live status of this gateway (GET /v1/info).
(function () {
  'use strict';
  var H = window.Honk;

  // What the hero types for each tab, per language; the answers are in the markup.
  var demos = [
    {
      zh: 'curl $HONK/bot$TOKEN/sendMessage -d title=备份 -d body="夜间备份完成，共 12.4 GB"',
      en: 'curl $HONK/bot$TOKEN/sendMessage -d title=Backup -d body="nightly backup finished, 12.4 GB"',
    },
    {
      zh: 'honk send "api v1.8.2 已上线" --title 部署 --html @card.html --id deploy-api',
      en: 'honk send "api v1.8.2 is live" --title Deploy --html @card.html --id deploy-api',
    },
    {
      zh: 'requests.post(f"{url}/bot{token}/hook/alertmanager", json=alert)',
      en: 'requests.post(f"{url}/bot{token}/hook/alertmanager", json=alert)',
    },
  ];

  function heroDemo() {
    var box = document.getElementById('console');
    if (!box) return;
    var tabs = box.querySelectorAll('[role=tab]');
    var text = box.querySelector('.query-text');
    var answers = box.querySelectorAll('.answer');
    var run = box.querySelector('.run');
    var cur = 0, typed = 0, pinned = false, typer = 0, rotor = 0;

    function cmd() { return demos[cur][H.lang()] || demos[cur].en; }
    function draw() {
      var c = cmd(), done = typed >= c.length;
      text.textContent = c.slice(0, typed);
      if (!done) {
        var caret = document.createElement('span');
        caret.className = 'caret';
        text.appendChild(caret);
      }
      for (var i = 0; i < answers.length; i++) {
        var on = i === cur && done;
        answers[i].classList.toggle('show', on);
        answers[i].setAttribute('aria-hidden', on ? 'false' : 'true');
      }
      return done;
    }
    function start(i) {
      cur = i;
      for (var k = 0; k < tabs.length; k++) {
        tabs[k].setAttribute('aria-selected', k === i ? 'true' : 'false');
        tabs[k].tabIndex = k === i ? 0 : -1;
      }
      clearInterval(typer);
      clearTimeout(rotor);
      // Restart the answer's entrance animation.
      for (var a = 0; a < answers.length; a++) answers[a].classList.remove('show');
      if (H.reduced) { typed = cmd().length; draw(); return; }
      typed = 0;
      draw();
      typer = setInterval(function () {
        typed++;
        if (draw()) {
          clearInterval(typer);
          if (!pinned) rotor = setTimeout(function () { start((cur + 1) % demos.length); }, 3800);
        }
      }, 30);
    }
    for (var k = 0; k < tabs.length; k++) (function (idx) {
      tabs[idx].addEventListener('click', function () { pinned = true; start(idx); });
      tabs[idx].addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        pinned = true;
        var n = (idx + d + tabs.length) % tabs.length;
        start(n);
        tabs[n].focus();
      });
    })(k);
    if (run) run.addEventListener('click', function () { start(cur); });
    document.addEventListener('honk:lang', function () { start(cur); });
    start(0);
  }

  // Lights the journey's steps one by one while it is on screen, then starts over.
  function journey() {
    var box = document.querySelector('.trace-box');
    if (!box) return;
    var steps = box.querySelectorAll('.step');
    var foot = box.querySelector('.trace-foot');
    var total = steps.length, on = 0, id = 0;
    function paint() {
      for (var i = 0; i < total; i++) steps[i].classList.toggle('on', i < on);
      if (foot) foot.classList.toggle('on', on > total);
    }
    if (H.reduced || !('IntersectionObserver' in window)) { on = total + 1; paint(); return; }
    paint();
    new IntersectionObserver(function (entries) {
      clearInterval(id);
      if (!entries[0] || !entries[0].isIntersecting) return;
      id = setInterval(function () { on = on > total + 3 ? 0 : on + 1; paint(); }, 650);
    }).observe(box);
  }

  // The "this gateway" card and the hero's version tag read /v1/info.
  function gatewayInfo() {
    var card = document.getElementById('status');
    var tags = document.querySelectorAll('[data-info=version]');
    if (!card && !tags.length) return;
    function set(key, value) {
      var n = card && card.querySelectorAll('[data-info=' + key + ']');
      for (var i = 0; n && i < n.length; i++) n[i].textContent = value;
    }
    var label = {
      direct: { zh: '直连', en: 'direct' },
      relay: { zh: '经中继', en: 'via relay' },
      off: { zh: '关闭', en: 'off' },
    };
    var info = null;
    function render() {
      if (!info) return;
      var lang = H.lang();
      var route = function (r) { return (label[r] && label[r][lang]) || r || '—'; };
      for (var t = 0; t < tags.length; t++) tags[t].textContent = info.version || 'dev';
      set('version', info.version || 'dev');
      set('api', String(info.api || '—'));
      set('ios', route(info.push && info.push.ios));
      set('android', route(info.push && info.push.android));
      set('features', (info.features || []).join(' · ') || '—');
      set('register', info.register_key_required ? (lang === 'zh' ? '需要注册密钥' : 'register key required') : (lang === 'zh' ? '开放' : 'open'));
    }
    if (!window.fetch) return;
    fetch('/v1/info', { headers: { Accept: 'application/json' }, credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('bad answer');
        info = j.result;
        if (card) card.classList.add('up');
        render();
        document.addEventListener('honk:lang', render);
      })
      .catch(function () { if (card) card.classList.add('down'); });
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  ready(function () { heroDemo(); journey(); gatewayInfo(); });
})();
