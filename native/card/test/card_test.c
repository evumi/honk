// Tests of the card sandbox: `make -C native test`.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "honk_card.h"

static int failures;
static int g_allow; // the next loaded card allows request()
static int g_allow; // the next loaded card allows request()

#define CHECK(cond, ...)                                       \
    do {                                                       \
        if (!(cond)) {                                         \
            failures++;                                        \
            fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
            fprintf(stderr, __VA_ARGS__);                      \
            fprintf(stderr, "\n");                             \
        }                                                      \
    } while (0)

static double ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

/** load JSON for a card whose page is `html_nodes` (JSON nodes) and whose one script is `script` (a JSON string). */
static char *load(const char *nodes, const char *script) {
    const char *fmt =
        "{\"tree\":[%s%s{\"type\":\"element\",\"tag\":\"script\",\"attrs\":{},\"children\":[{\"type\":\"text\",\"text\":%s}]}],"
        "\"data\":\"{\\\"n\\\":5}\",\"theme\":{\"--tg-theme-bg-color\":\"#ffffff\",\"--tg-color-scheme\":\"light\"},\"language\":\"en\",\"active\":true,\"allowQueries\":%s}";
    size_t n = strlen(fmt) + strlen(nodes) + strlen(script) + 8;
    char *s = malloc(n);
    snprintf(s, n, fmt, nodes, *nodes ? "," : "", script, g_allow ? "true" : "false");
    return s;
}

static const char *P = "{\"type\":\"element\",\"tag\":\"p\",\"attrs\":{\"id\":\"out\"},\"children\":[{\"type\":\"text\",\"text\":\"static\"}]}";

/** Opens a card, returns it and its first result (caller frees both). */
static HonkCard *open_card(const char *script, char **result) {
    char *l = load(P, script);
    HonkCard *c = honk_card_open(l, NULL, result);
    free(l);
    return c;
}

static int has(const char *s, const char *needle) { return s && strstr(s, needle) != NULL; }

static void test_runs_and_draws(void) {
    char *r;
    HonkCard *c = open_card("\"document.getElementById('out').textContent = 'hello ' + JSON.parse(TelegramWidget.chatData).n + ' ' + TelegramWidget.colorScheme + ' ' + TelegramWidget.themeParams.bg_color\"", &r);
    CHECK(has(r, "hello 5 light #ffffff"), "script output missing: %s", r);
    CHECK(has(r, "\"stopped\":null"), "should not stop: %s", r);
    honk_card_free_string(r);
    // Nothing changed: no tree.
    r = honk_card_tick(c);
    CHECK(has(r, "\"tree\":null"), "unchanged tree sent again: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_no_host_access(void) {
    char *r;
    HonkCard *c = open_card(
        "\"var out = []; for (var name of ['std','os','require','process','scriptArgs','print','__honk','Deno','Bun']) out.push(name + ':' + typeof globalThis[name]);"
        "for (var f of ['fetch','XMLHttpRequest','WebSocket']) { try { window[f]('https://example.com') } catch (e) { out.push(f + ':' + e.name) } }"
        "document.getElementById('out').textContent = out.join(',')\"",
        &r);
    CHECK(has(r, "std:undefined,os:undefined,require:undefined,process:undefined,scriptArgs:undefined"), "host globals visible: %s", r);
    CHECK(has(r, "fetch:NetworkDisabledError,XMLHttpRequest:NetworkDisabledError,WebSocket:NetworkDisabledError"), "network not refused: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_endless_loop_stops(void) {
    char *r;
    double t = ms();
    HonkCard *c = open_card("\"document.getElementById('out').textContent = 'drawn'; try { while (true) {} } catch (e) {} document.getElementById('out').textContent = 'after'\"", &r);
    double took = ms() - t;
    CHECK(took < 1000, "loop not stopped in time: %.0f ms", took);
    CHECK(has(r, "\"stopped\":\"time\""), "not stopped for time: %s", r);
    CHECK(has(r, "\"text\":\"drawn\"") && !has(r, "\"text\":\"after\""), "last tree missing or catch ran on: %s", r);
    CHECK(honk_card_next(c) < 0, "stopped card has a next tick");
    honk_card_free_string(r);
    r = honk_card_click(c, "[0]");
    CHECK(has(r, "\"stopped\":\"time\"") && has(r, "\"tree\":null"), "stopped card ran again: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_memory_limit(void) {
    char *r;
    HonkCard *c = open_card("\"var keep = []; for (;;) keep.push(new Array(100000).fill(1.5))\"", &r);
    CHECK(has(r, "\"stopped\":\"memory\""), "not stopped for memory: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_recursion_is_catchable(void) {
    char *r;
    HonkCard *c = open_card("\"function f() { return f() } var name = ''; try { f() } catch (e) { name = e.name } document.getElementById('out').textContent = 'caught ' + name\"", &r);
    CHECK(has(r, "caught ") && has(r, "\"stopped\":null"), "deep recursion: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_taps_links_and_copy(void) {
    char *r;
    HonkCard *c = open_card(
        "\"var n = 0; var b = document.createElement('button'); b.textContent = 'tap'; document.body.appendChild(b);"
        "b.addEventListener('click', function (e) { n++; b.textContent = 'tapped ' + n; TelegramWidget.openLink('https://example.com/' + n); TelegramWidget.openLink('https://example.com/again'); TelegramWidget.copyText('copied ' + n); if (n === 2) e.preventDefault() });"
        "TelegramWidget.openLink('https://example.com/at-load');\"",
        &r);
    CHECK(!has(r, "\"open\""), "link opened outside a tap: %s", r);
    CHECK(has(r, "\"on\":true"), "button not marked pressable: %s", r);
    honk_card_free_string(r);
    // The button is the third node: p, script, button.
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "tapped 1") && has(r, "\"open\":\"https://example.com/1\"") && has(r, "\"copy\":\"copied 1\"") && has(r, "\"prevented\":false"), "first tap: %s", r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"open\":\"https://example.com/2\"") && has(r, "\"prevented\":true"), "second tap: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_tampering_cannot_forge_effects(void) {
    char *r;
    // The card rewrites what runtime.js would report and adds a getter on every object.
    HonkCard *c = open_card(
        "\"Object.defineProperty(Object.prototype, 'open', { get: function () { return 'https://evil.example' } });"
        "JSON.stringify = function () { return '{\\\"next\\\":0,\\\"open\\\":\\\"javascript:alert(1)\\\",\\\"copy\\\":\\\"x\\\"}' };"
        "var b = document.createElement('i'); b.onclick = function () {}; document.body.appendChild(b);\"",
        &r);
    CHECK(!has(r, "\"open\":") && !has(r, "\"copy\":"), "forged effect at load: %s", r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    // A forged link must be https: javascript: is refused even in a tap.
    CHECK(!has(r, "\"open\":") && !has(r, "\"copy\":"), "forged effect in a tap: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_timers_and_promises(void) {
    char *r;
    HonkCard *c = open_card(
        "\"var p = document.getElementById('out'); var n = 0;"
        "var id = setInterval(function () { n++; p.textContent = 'tick ' + n; if (n === 2) clearInterval(id) }, 20);"
        "TelegramWidget.request('hi').catch(function (e) { p.dataset.req = e.name + ':' + e.code })\"",
        &r);
    CHECK(has(r, "WidgetRequestError:NOT_ALLOWED"), "request not refused: %s", r);
    double next = honk_card_next(c);
    CHECK(next >= 0 && next <= 20, "next tick: %f", next);
    honk_card_free_string(r);
    for (int i = 0; i < 2; i++) {
        usleep(25000);
        r = honk_card_tick(c);
        honk_card_free_string(r);
    }
    usleep(25000);
    r = honk_card_tick(c);
    CHECK(has(r, "\"tree\":null"), "ticked after clearInterval: %s", r);
    CHECK(honk_card_next(c) < 0, "timer left after clearInterval");
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_same_writes_change_nothing(void) {
    char *r;
    HonkCard *c = open_card(
        "\"var p = document.getElementById('out'); p.textContent = 'same'; p.setAttribute('class', 'a');"
        "setInterval(function () { p.textContent = 'same'; p.setAttribute('class', 'a'); p.innerHTML = 'same' }, 16)\"",
        &r);
    honk_card_free_string(r);
    unsigned long mem = honk_card_memory(c);
    CHECK(mem > 0 && mem < 8 * 1024 * 1024, "memory: %lu", mem);
    usleep(20000);
    r = honk_card_tick(c);
    CHECK(has(r, "\"tree\":null"), "same writes sent a tree: %.200s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_cpu_per_second(void) {
    char *r;
    HonkCardLimits l = honk_card_default_limits();
    l.task_ms = 150;
    l.cpu_per_second_ms = 100;
    char *ld = load(P, "\"setInterval(function () { var t = Date.now(); while (Date.now() - t < 120) {} }, 16)\"");
    HonkCard *c = honk_card_open(ld, &l, &r);
    free(ld);
    honk_card_free_string(r);
    usleep(20000);
    r = honk_card_tick(c);
    honk_card_free_string(r);
    double next = honk_card_next(c);
    CHECK(next > 500, "a busy card was not held back to the next second: %f", next);
    honk_card_close(c);
}

/** Like open_card, with a time budget that also holds under sanitizers (about 10x slower). */
static HonkCard *open_card_slow(const char *script, char **result) {
    HonkCardLimits l = honk_card_default_limits();
    l.task_ms = 3000;
    l.cpu_per_second_ms = 3000;
    char *ld = load(P, script);
    HonkCard *c = honk_card_open(ld, &l, result);
    free(ld);
    return c;
}

static void test_dom_and_output_limits(void) {
    char *r;
    HonkCard *c = open_card_slow(
        "\"var d = document.createElement('div'); document.body.appendChild(d); var n = 0;"
        "try { for (;;) { d.appendChild(document.createElement('span')); n++ } } catch (e) { d.dataset.n = n; d.dataset.err = e.name }"
        "d.innerHTML = '<p class=\\\"x\\\">a</p><b>b</b>'; var p = d.querySelector('div > p.x');"
        "p.appendChild(document.createElement('i')); d.dataset.q = String(!!p) + document.querySelectorAll('i').length + p.isConnected\"",
        &r);
    CHECK(has(r, "\"data-err\":\"RangeError\""), "node limit not enforced: %s", r);
    CHECK(has(r, "\"data-q\":\"true1true\""), "innerHTML or selectors wrong: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);

    c = open_card_slow("\"document.body.textContent = 'x'.repeat(600000)\"", &r);
    CHECK(has(r, "\"stopped\":\"output\""), "oversized page not stopped: %.200s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_bad_scripts_and_theme_events(void) {
    char *r;
    HonkCard *c = open_card(
        "\"class A { get x() { return 1 } } var p = document.getElementById('out'); p.textContent = 'es2023 ' + new A().x + [1,2,3].at(-1) + (/a+/.test('aa'));"
        "TelegramWidget.onEvent('themeChanged', function () { p.dataset.scheme = this.colorScheme });"
        "throw new Error('boom')\"",
        &r);
    CHECK(has(r, "es2023 13true"), "modern JS failed: %s", r);
    CHECK(has(r, "Uncaught Error: boom") && has(r, "\"stopped\":null"), "uncaught error not logged: %s", r);
    honk_card_free_string(r);
    r = honk_card_set(c, "{\"theme\":{\"--tg-color-scheme\":\"dark\"}}");
    CHECK(has(r, "\"data-scheme\":\"dark\""), "themeChanged not fired: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);

    c = open_card("\"this is not javascript\"", &r);
    CHECK(has(r, "SyntaxError") && has(r, "static"), "syntax error: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

// MARK: request()

static HonkCard *open_queries(int allow, const char *script, char **r) {
    g_allow = allow;
    HonkCard *c = open_card(script, r);
    g_allow = 0;
    return c;
}

static void test_request_basics(void) {
    char *r;
    HonkCard *c = open_queries(1,
        "\"var p = document.getElementById('out');"
        "TelegramWidget.request('early').catch(function (e) { p.dataset.early = e.name + ':' + e.code });"
        "var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () {"
        "  var r1 = TelegramWidget.request('ping');"
        "  var r2 = TelegramWidget.request('pong');"
        "  r1.then(function (v) { p.textContent = 'got ' + v }, function (e) { p.textContent = 'err ' + e.code });"
        "  r2.catch(function (e) { p.dataset.second = e.code });"
        "  setTimeout(function () { TelegramWidget.request('late').catch(function (e) { p.dataset.late = e.code }) }, 0);"
        "});\"",
        &r);
    CHECK(has(r, "\"data-early\":\"WidgetRequestError:NOT_ALLOWED\"") && !has(r, "\"request\""), "request outside a tap: %s", r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"request\":{\"seq\":1,\"data\":\"ping\"}"), "request missing: %s", r);
    CHECK(has(r, "\"data-second\":\"NOT_ALLOWED\""), "second request in a tap: %s", r);
    CHECK(!has(r, "\"data\":\"pong\"") && !has(r, "\"text\":\"got "), "second request sent or early answer: %s", r);
    honk_card_free_string(r);
    // A timer's request is not from a tap.
    usleep(5000);
    r = honk_card_tick(c);
    CHECK(has(r, "\"data-late\":\"NOT_ALLOWED\"") && !has(r, "\"request\""), "request from a timer: %s", r);
    honk_card_free_string(r);
    // The answer resolves the promise and the card redraws.
    r = honk_card_answer(c, 1, 1, "pong \xf0\x9f\x98\x80", 9);
    CHECK(has(r, "got pong \xf0\x9f\x98\x80") && has(r, "\"stopped\":null") && !has(r, "\"request\""), "answer not delivered: %s", r);
    honk_card_free_string(r);
    // Answered once; again, and unknown seqs, change nothing.
    r = honk_card_answer(c, 1, 1, "again", 5);
    CHECK(has(r, "\"tree\":null") && has(r, "\"stopped\":null"), "second answer: %s", r);
    honk_card_free_string(r);
    r = honk_card_answer(c, 99, 1, "x", 1);
    CHECK(has(r, "\"tree\":null"), "unknown seq: %s", r);
    honk_card_free_string(r);
    r = honk_card_answer(c, -5, 1, "x", 1);
    CHECK(has(r, "\"tree\":null"), "negative seq: %s", r);
    honk_card_free_string(r);
    // Every tap may ask again; the sequence goes on.
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"request\":{\"seq\":2,\"data\":\"ping\"}"), "second tap: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_request_data_limits(void) {
    char *r;
    HonkCard *c = open_queries(1,
        "\"var p = document.getElementById('out'); var n = 0;"
        "var args = ['', 'a'.repeat(64), 'a'.repeat(65), '\\u00e9'.repeat(32), '\\u00e9'.repeat(33), '\\ud83d\\ude00'.repeat(16), '\\ud83d\\ude00'.repeat(17), 5, null, {}];"
        "var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () { var i = n++;"
        "  TelegramWidget.request(args[i]).catch(function (e) { p.dataset['e' + i] = e.code }) });\"",
        &r);
    honk_card_free_string(r);
    // Valid: 1 (64 ASCII), 3 (32 two-byte), 5 (16 four-byte).
    static const int valid[10] = {0, 1, 0, 1, 0, 1, 0, 0, 0, 0};
    int seq = 0;
    for (int i = 0; i < 10; i++) {
        r = honk_card_click(c, "[2]");
        if (valid[i]) {
            seq++;
            CHECK(has(r, "\"request\":{\"seq\":") && !has(r, "INVALID_DATA"), "arg %d refused: %s", i, r);
        } else {
            CHECK(!has(r, "\"request\"") && has(r, "INVALID_DATA"), "arg %d accepted: %s", i, r);
        }
        honk_card_free_string(r);
        if (valid[i]) {
            r = honk_card_answer(c, seq, 1, "ok", 2);
            honk_card_free_string(r);
        }
    }
    honk_card_close(c);
}

static void test_request_edge_cases(void) {
    char *r;
    // U+0000 is refused in JS (INVALID_DATA), never truncated and sent.
    HonkCard *c = open_queries(1,
        "\"var p = document.getElementById('out');"
        "var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () {"
        "  TelegramWidget.request('ab\\u0000cd').catch(function (e) { p.dataset.nul = e.code }) });\"",
        &r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"data-nul\":\"INVALID_DATA\"") && !has(r, "\"request\""), "NUL in request data: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);

    // A lone surrogate passes the JS length check but is not UTF-8: the C side refuses it, and the
    // promise rejects at once instead of waiting for TIMEOUT.
    c = open_queries(1,
        "\"var p = document.getElementById('out');"
        "var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () {"
        "  TelegramWidget.request('a\\ud800').then(function () { p.dataset.r = 'ok' }, function (e) { p.dataset.r = e.code }) });\"",
        &r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(!has(r, "\"request\"") && has(r, "\"data-r\":\"INVALID_DATA\"") && has(r, "\"stopped\":null"), "C-side refusal left pending: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);

    // A task that stops the card (page too large) sends no request.
    c = open_queries(1,
        "\"var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () {"
        "  TelegramWidget.request('ping'); document.body.textContent = 'x'.repeat(600000) });\"",
        &r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"stopped\":\"output\"") && !has(r, "\"request\""), "request sent by a stopped card: %.300s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_request_not_allowed(void) {
    char *r;
    HonkCard *c = open_queries(0,
        "\"var p = document.getElementById('out');"
        "var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () { TelegramWidget.request('hi').catch(function (e) { p.dataset.code = e.code }) });\"",
        &r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"data-code\":\"NOT_ALLOWED\"") && !has(r, "\"request\""), "allowQueries false: %s", r);
    honk_card_free_string(r);
    r = honk_card_answer(c, 1, 1, "x", 1);
    CHECK(has(r, "\"tree\":null"), "answer without a request: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_request_in_flight_and_failures(void) {
    char *r;
    HonkCard *c = open_queries(1,
        "\"var p = document.getElementById('out'); var n = 0;"
        "var b = document.createElement('button'); document.body.appendChild(b);"
        "b.addEventListener('click', function () { var i = ++n;"
        "  TelegramWidget.request('r' + i).then(function (v) { p.dataset['v' + i] = v }, function (e) { p.dataset['e' + i] = e.name + ':' + e.code }) });\"",
        &r);
    honk_card_free_string(r);
    for (int i = 1; i <= 5; i++) {
        r = honk_card_click(c, "[2]");
        if (i <= 4) CHECK(has(r, "\"request\":{\"seq\":"), "request %d: %s", i, r);
        else CHECK(!has(r, "\"request\"") && has(r, "\"data-e5\":\"WidgetRequestError:TOO_MANY_REQUESTS\""), "fifth in flight: %s", r);
        honk_card_free_string(r);
    }
    r = honk_card_answer(c, 1, 0, "NETWORK", 7);
    CHECK(has(r, "\"data-e1\":\"WidgetRequestError:NETWORK\""), "failure code: %s", r);
    honk_card_free_string(r);
    r = honk_card_answer(c, 2, 0, "not a code!", 11);
    CHECK(has(r, "\"data-e2\":\"WidgetRequestError:REQUEST_FAILED\""), "bad failure code: %s", r);
    honk_card_free_string(r);
    // Oversized and non-UTF-8 answers fail the request; 1024 bytes is fine.
    char *big = malloc(1025);
    memset(big, 'a', 1025);
    r = honk_card_answer(c, 3, 1, big, 1025);
    CHECK(has(r, "\"data-e3\":\"WidgetRequestError:BAD_ANSWER\"") && !has(r, "aaaaaaaa"), "oversized answer: %s", r);
    honk_card_free_string(r);
    r = honk_card_answer(c, 4, 1, big, 1024);
    CHECK(has(r, "\"data-v4\":\"aaaaaaaa") && !has(r, "data-e4"), "1024 bytes: %s", r);
    honk_card_free_string(r);
    free(big);
    // A slot is free again (the refused fifth request took no seq).
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"request\":{\"seq\":5,"), "after answers: %s", r);
    honk_card_free_string(r);
    r = honk_card_answer(c, 5, 1, "\xc3\x28", 2);
    CHECK(has(r, "\"data-e6\":\"WidgetRequestError:BAD_ANSWER\""), "invalid UTF-8: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_request_timeout(void) {
    char *r;
    // The card moves its own clock: the real 15 s are not waited for.
    HonkCard *c = open_queries(1,
        "\"var p = document.getElementById('out'); var skew = 0; var real = Date.now;"
        "Date.now = function () { return real.call(Date) + skew };"
        "var a = document.createElement('button'); document.body.appendChild(a);"
        "var z = document.createElement('button'); document.body.appendChild(z);"
        "a.addEventListener('click', function () { TelegramWidget.request('slow').then(function () { p.textContent = 'answered' }, function (e) { p.textContent = e.name + ' ' + e.code }) });"
        "z.addEventListener('click', function () { skew = 16000 });\"",
        &r);
    honk_card_free_string(r);
    CHECK(honk_card_next(c) < 0, "timer before any request");
    r = honk_card_click(c, "[2]");
    CHECK(has(r, "\"request\":{\"seq\":1,\"data\":\"slow\"}"), "request: %s", r);
    honk_card_free_string(r);
    double next = honk_card_next(c);
    CHECK(next > 14000 && next <= 15000, "tick for the timeout due in %f ms", next);
    r = honk_card_tick(c);
    CHECK(has(r, "\"tree\":null"), "timed out too early: %s", r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[3]");
    honk_card_free_string(r);
    r = honk_card_tick(c);
    CHECK(has(r, "WidgetRequestError TIMEOUT"), "no timeout: %s", r);
    honk_card_free_string(r);
    CHECK(honk_card_next(c) < 0, "timer left after the timeout");
    r = honk_card_answer(c, 1, 1, "late", 4);
    CHECK(has(r, "\"tree\":null"), "answer after the timeout: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

static void test_request_cannot_be_forged(void) {
    char *r;
    // The card rewrites what runtime.js reports with a request too big for the limit.
    HonkCard *c = open_queries(1,
        "\"JSON.stringify = function () { return '{\\\"next\\\":-1,\\\"request\\\":{\\\"seq\\\":1,\\\"data\\\":\\\"' + 'x'.repeat(100) + '\\\"}}' };"
        "var b = document.createElement('i'); b.onclick = function () {}; document.body.appendChild(b);\"",
        &r);
    CHECK(!has(r, "\"request\""), "forged request at load: %s", r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(!has(r, "\"request\""), "oversized forged request: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);

    // A wrong seq is dropped too.
    c = open_queries(1,
        "\"JSON.stringify = function () { return '{\\\"next\\\":-1,\\\"request\\\":{\\\"seq\\\":-3,\\\"data\\\":\\\"x\\\"}}' };"
        "var b = document.createElement('i'); b.onclick = function () {}; document.body.appendChild(b);\"",
        &r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(!has(r, "\"request\""), "forged seq: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);

    // A getter on Object.prototype does not make one up, and a card cannot reach the answer entry.
    c = open_queries(1,
        "\"Object.defineProperty(Object.prototype, 'request', { get: function () { return {seq: 1, data: 'x'} } });"
        "var p = document.getElementById('out'); p.textContent = typeof globalThis.answer + typeof TelegramWidget.answer;"
        "var b = document.createElement('i'); b.onclick = function () {}; document.body.appendChild(b);\"",
        &r);
    CHECK(has(r, "undefinedundefined"), "answer reachable: %s", r);
    honk_card_free_string(r);
    r = honk_card_click(c, "[2]");
    CHECK(!has(r, "\"request\""), "inherited request: %s", r);
    honk_card_free_string(r);
    honk_card_close(c);
}

int main(void) {
    test_runs_and_draws();
    test_no_host_access();
    test_endless_loop_stops();
    test_memory_limit();
    test_recursion_is_catchable();
    test_taps_links_and_copy();
    test_tampering_cannot_forge_effects();
    test_timers_and_promises();
    test_same_writes_change_nothing();
    test_cpu_per_second();
    test_dom_and_output_limits();
    test_bad_scripts_and_theme_events();
    test_request_basics();
    test_request_data_limits();
    test_request_edge_cases();
    test_request_not_allowed();
    test_request_in_flight_and_failures();
    test_request_timeout();
    test_request_cannot_be_forged();
    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("card tests passed\n");
    return 0;
}
