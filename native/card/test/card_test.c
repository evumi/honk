// Tests of the card sandbox: `make -C native test`.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "honk_card.h"

static int failures;

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
        "\"data\":\"{\\\"n\\\":5}\",\"theme\":{\"--tg-theme-bg-color\":\"#ffffff\",\"--tg-color-scheme\":\"light\"},\"language\":\"en\",\"active\":true}";
    size_t n = strlen(fmt) + strlen(nodes) + strlen(script) + 8;
    char *s = malloc(n);
    snprintf(s, n, fmt, nodes, *nodes ? "," : "", script);
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

int main(void) {
    test_runs_and_draws();
    test_no_host_access();
    test_endless_loop_stops();
    test_memory_limit();
    test_recursion_is_catchable();
    test_taps_links_and_copy();
    test_tampering_cannot_forge_effects();
    test_timers_and_promises();
    test_cpu_per_second();
    test_dom_and_output_limits();
    test_bad_scripts_and_theme_events();
    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("card tests passed\n");
    return 0;
}
