// See honk_card.h. Everything a card's own code could tamper with is read
// defensively: the C side takes runtime.js's entry points before any card
// script runs, reads results through JSON it parses itself and own data
// properties (never getters), and checks links, copied text and sizes here.

#include "honk_card.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "quickjs.h"
#include "runtime_js.h"

/** Largest tree a card may hand back, in bytes of JSON. */
#define MAX_TREE_BYTES (512 * 1024)
#define MAX_LOGS 20
#define MAX_LINK 256

enum { FN_LOAD, FN_SCRIPT, FN_READY, FN_CLICK, FN_TICK, FN_SET, FN_TREE, FN_EFFECTS, FN_COUNT };
static const char *const FN_NAMES[FN_COUNT] = {"load", "script", "ready", "click", "tick", "set", "tree", "effects"};

struct HonkCard {
    JSRuntime *rt;
    JSContext *ctx;
    JSValue fns[FN_COUNT];
    HonkCardLimits limits;
    double deadline; // monotonic ms; 0 when no task runs
    bool interrupted;
    bool oom;          // an allocation went past the limit: stop at the next check
    size_t allocated;  // bytes the card's runtime holds
    const char *stopped; // static string once the card stopped
    bool tree_read_after_stop;
    double window_start, window_used;
    double next; // ms from `next_at` until the next tick, < 0 none
    double next_at;
    // Output of the current call.
    char *logs[MAX_LOGS];
    int nlogs;
};

static double now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e3 + (double)ts.tv_nsec / 1e6;
}

// The card's allocator: counts what its runtime holds and refuses past the
// limit. QuickJS turns a refused allocation into an "out of memory" error,
// which a script could catch; the interrupt below makes it final.

#define HEADER 16 // keeps 16-byte alignment

static void *card_malloc(void *opaque, size_t size) {
    HonkCard *c = opaque;
    if (size > c->limits.memory || c->allocated + size > c->limits.memory) {
        c->oom = true;
        return NULL;
    }
    unsigned char *p = malloc(size + HEADER);
    if (!p) {
        c->oom = true;
        return NULL;
    }
    *(size_t *)p = size;
    c->allocated += size;
    return p + HEADER;
}

static void card_free(void *opaque, void *ptr) {
    if (!ptr) return;
    HonkCard *c = opaque;
    unsigned char *p = (unsigned char *)ptr - HEADER;
    c->allocated -= *(size_t *)p;
    free(p);
}

static void *card_calloc(void *opaque, size_t count, size_t size) {
    if (size && count > ((size_t)-1) / size) return NULL;
    void *p = card_malloc(opaque, count * size);
    if (p) memset(p, 0, count * size);
    return p;
}

static void *card_realloc(void *opaque, void *ptr, size_t size) {
    if (!ptr) return card_malloc(opaque, size);
    HonkCard *c = opaque;
    unsigned char *p = (unsigned char *)ptr - HEADER;
    size_t old = *(size_t *)p;
    if (size == 0) {
        card_free(opaque, ptr);
        return NULL;
    }
    if (size > old && (size > c->limits.memory || c->allocated + (size - old) > c->limits.memory)) {
        c->oom = true;
        return NULL;
    }
    unsigned char *q = realloc(p, size + HEADER);
    if (!q) {
        c->oom = true;
        return NULL;
    }
    *(size_t *)q = size;
    c->allocated = c->allocated - old + size;
    return q + HEADER;
}

static size_t card_usable_size(const void *ptr) {
    return ptr ? *(const size_t *)((const unsigned char *)ptr - HEADER) : 0;
}

static const JSMallocFunctions card_malloc_functions = {card_calloc, card_malloc, card_free, card_realloc, card_usable_size};

static int interrupt_handler(JSContext *ctx, void *opaque) {
    (void)ctx;
    HonkCard *c = opaque;
    if (c->oom) return 1;
    if (c->deadline > 0 && now_ms() > c->deadline) {
        c->interrupted = true;
        return 1;
    }
    return 0;
}

HonkCardLimits honk_card_default_limits(void) {
    HonkCardLimits l = {8 * 1024 * 1024, 256 * 1024, 200, 300};
    return l;
}

// MARK: output

typedef struct {
    char *buf;
    size_t len, cap;
    bool failed;
} Buf;

static void buf_put(Buf *b, const char *s, size_t n) {
    if (b->failed) return;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < b->len + n + 1) cap *= 2;
        char *p = realloc(b->buf, cap);
        if (!p) {
            b->failed = true;
            return;
        }
        b->buf = p;
        b->cap = cap;
    }
    memcpy(b->buf + b->len, s, n);
    b->len += n;
    b->buf[b->len] = 0;
}

static void buf_str(Buf *b, const char *s) { buf_put(b, s, strlen(s)); }

/** A JSON string literal for UTF-8 `s`. */
static void buf_json_string(Buf *b, const char *s, size_t n) {
    buf_put(b, "\"", 1);
    for (size_t i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)s[i];
        char esc[8];
        if (ch == '"' || ch == '\\') {
            esc[0] = '\\';
            esc[1] = (char)ch;
            buf_put(b, esc, 2);
        } else if (ch < 0x20) {
            snprintf(esc, sizeof esc, "\\u%04x", ch);
            buf_put(b, esc, 6);
        } else {
            buf_put(b, (const char *)&s[i], 1);
        }
    }
    buf_put(b, "\"", 1);
}

static void add_log(HonkCard *c, const char *msg) {
    if (c->nlogs >= MAX_LOGS || !msg) return;
    size_t n = strlen(msg);
    if (n > 500) n = 500;
    char *s = malloc(n + 1);
    if (!s) return;
    memcpy(s, msg, n);
    s[n] = 0;
    c->logs[c->nlogs++] = s;
}

static void stop(HonkCard *c, const char *reason) {
    if (!c->stopped) c->stopped = reason;
    c->next = -1;
}

// MARK: reading the card's values safely

/** An own data property of `obj` (never a getter), or JS_UNDEFINED. The caller frees it. */
static JSValue own(JSContext *ctx, JSValueConst obj, const char *name) {
    if (!JS_IsObject(obj)) return JS_UNDEFINED;
    JSAtom atom = JS_NewAtom(ctx, name);
    JSPropertyDescriptor desc;
    int r = JS_GetOwnProperty(ctx, &desc, obj, atom);
    JS_FreeAtom(ctx, atom);
    if (r <= 0) {
        if (r < 0) JS_FreeValue(ctx, JS_GetException(ctx));
        return JS_UNDEFINED;
    }
    JS_FreeValue(ctx, desc.getter);
    JS_FreeValue(ctx, desc.setter);
    if (desc.flags & JS_PROP_GETSET) {
        JS_FreeValue(ctx, desc.value);
        return JS_UNDEFINED;
    }
    return desc.value;
}

/** A copy of a JS string value (not converted: anything else gives NULL). */
static char *string_of(JSContext *ctx, JSValueConst v, size_t *len) {
    if (!JS_IsString(v)) return NULL;
    size_t n;
    const char *s = JS_ToCStringLen2(ctx, &n, v, false);
    if (!s) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        return NULL;
    }
    char *out = malloc(n + 1);
    if (out) {
        memcpy(out, s, n);
        out[n] = 0;
    }
    JS_FreeCString(ctx, s);
    if (len) *len = n;
    return out;
}

/** Records why an exception happened: an interrupt or running out of memory stops the card. */
static void handle_exception(HonkCard *c) {
    JSContext *ctx = c->ctx;
    JSValue e = JS_GetException(ctx);
    if (c->oom) {
        add_log(c, "card script used too much memory");
        stop(c, "memory");
    } else if (c->interrupted || JS_IsUncatchableError(e)) {
        add_log(c, "card script ran too long");
        stop(c, "time");
    } else {
        JSValue msg = own(ctx, e, "message");
        char *m = string_of(ctx, msg, NULL);
        JSValue name = own(ctx, e, "name");
        char *n = string_of(ctx, name, NULL);
        if (!m && JS_IsString(e)) m = string_of(ctx, e, NULL);
        if (m && strstr(m, "out of memory")) {
            add_log(c, "card script used too much memory");
            stop(c, "memory");
        } else {
            char line[600];
            snprintf(line, sizeof line, "Uncaught %s: %s", n ? n : "Error", m ? m : "(no message)");
            add_log(c, line);
        }
        free(m);
        free(n);
        JS_FreeValue(ctx, msg);
        JS_FreeValue(ctx, name);
    }
    JS_FreeValue(ctx, e);
}

// MARK: tasks

/** Starts a task's budget; false when the card cannot run. `force`: also for a card stopped for time (to read its last tree). */
static bool begin_task(HonkCard *c, double budget_ms, bool force) {
    if (c->stopped && !(force && strcmp(c->stopped, "time") == 0)) return false;
    JS_UpdateStackTop(c->rt);
    c->interrupted = false;
    c->deadline = now_ms() + budget_ms;
    return true;
}

static void end(HonkCard *c, double started) {
    double t = now_ms();
    c->deadline = 0;
    if (t - c->window_start >= 1000) {
        c->window_start = t;
        c->window_used = 0;
    }
    c->window_used += t - started;
}

/** Runs promise jobs within the current task's budget. */
static void run_jobs(HonkCard *c) {
    for (int i = 0; i < 10000 && !c->stopped && JS_IsJobPending(c->rt); i++) {
        JSContext *jctx;
        if (JS_ExecutePendingJob(c->rt, &jctx) < 0) handle_exception(c);
    }
}

static bool begin(HonkCard *c, double budget_ms) { return begin_task(c, budget_ms, false); }

/** Calls one of runtime.js's entry points with a string argument, as one task. Returns its value (or JS_EXCEPTION). */
static JSValue call_task(HonkCard *c, int fn, const char *arg, double budget_ms, bool force) {
    if (!begin_task(c, budget_ms, force)) return JS_EXCEPTION;
    double started = now_ms();
    JSValue argv[1] = {arg ? JS_NewString(c->ctx, arg) : JS_UNDEFINED};
    JSValue r = JS_Call(c->ctx, c->fns[fn], JS_UNDEFINED, arg ? 1 : 0, argv);
    JS_FreeValue(c->ctx, argv[0]);
    if (JS_IsException(r)) handle_exception(c);
    else run_jobs(c);
    if (c->oom && !c->stopped) {
        add_log(c, "card script used too much memory");
        stop(c, "memory");
    }
    end(c, started);
    return r;
}

static JSValue call(HonkCard *c, int fn, const char *arg, double budget_ms) { return call_task(c, fn, arg, budget_ms, false); }

static void call_void(HonkCard *c, int fn, const char *arg) {
    JS_FreeValue(c->ctx, call(c, fn, arg, c->limits.task_ms));
}

static bool safe_link(const char *s, size_t n) {
    if (n < 9 || n > MAX_LINK || strncmp(s, "https://", 8) != 0) return false;
    for (size_t i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)s[i];
        if (ch <= 0x20 || ch == 0x7f || ch == '\\') return false;
    }
    return true;
}

/** The text is 1–256 UTF-16 units (counted from UTF-8, where a 4-byte sequence is two). */
static bool safe_copy(const char *s, size_t n) {
    size_t units = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)s[i];
        if ((ch & 0xc0) != 0x80) units += ch >= 0xf0 ? 2 : 1;
    }
    return units >= 1 && units <= 256;
}

/**
 * The result of a call: the tree when it changed, the effects runtime.js
 * recorded, checked here. `tap`: the call was a real tap, so one link and one
 * copy may go out.
 */
static char *finish(HonkCard *c, bool tap, int prevented) {
    Buf b = {0};
    JSContext *ctx = c->ctx;
    char *tree = NULL;
    size_t tree_len = 0;
    char *open = NULL, *copy = NULL;

    if (!c->stopped) {
        // Effects first: they also say when the next timer is due.
        JSValue ev = call(c, FN_EFFECTS, NULL, 50);
        char *json = string_of(ctx, ev, NULL);
        JS_FreeValue(ctx, ev);
        c->next = -1;
        if (json) {
            JSValue o = JS_ParseJSON(ctx, json, strlen(json), "<effects>");
            if (JS_IsException(o)) handle_exception(c);
            JSValue next = own(ctx, o, "next");
            double d;
            if (JS_IsNumber(next) && JS_ToFloat64(ctx, &d, next) == 0 && d >= 0) c->next = d;
            JS_FreeValue(ctx, next);
            if (tap) {
                size_t n;
                JSValue v = own(ctx, o, "open");
                open = string_of(ctx, v, &n);
                if (open && !safe_link(open, n)) {
                    add_log(c, "openLink needs an https:// URL of at most 256 characters");
                    free(open);
                    open = NULL;
                }
                JS_FreeValue(ctx, v);
                v = own(ctx, o, "copy");
                copy = string_of(ctx, v, &n);
                if (copy && !safe_copy(copy, n)) {
                    add_log(c, "copyText takes 1 to 256 characters");
                    free(copy);
                    copy = NULL;
                }
                JS_FreeValue(ctx, v);
            }
            JSValue logs = own(ctx, o, "logs");
            if (JS_IsArray(logs)) {
                for (uint32_t i = 0; i < MAX_LOGS; i++) {
                    char key[16];
                    snprintf(key, sizeof key, "%u", i);
                    JSValue l = own(ctx, logs, key);
                    char *s = string_of(ctx, l, NULL);
                    JS_FreeValue(ctx, l);
                    if (!s) break;
                    add_log(c, s);
                    free(s);
                }
            }
            JS_FreeValue(ctx, logs);
            JS_FreeValue(ctx, o);
            free(json);
        }
        if (c->next >= 0 && c->window_used >= c->limits.cpu_per_second_ms) {
            // Over this second's budget: the next tick waits for the next second.
            double wait = c->window_start + 1000 - now_ms();
            if (wait > c->next) c->next = wait;
        }
        c->next_at = now_ms();
    }
    // A card stopped for running too long keeps what it drew: read its tree once more.
    bool read_tree = !c->stopped || (strcmp(c->stopped, "time") == 0 && !c->tree_read_after_stop);
    if (read_tree) {
        if (c->stopped) c->tree_read_after_stop = true;
        JSValue tv = call_task(c, FN_TREE, NULL, 100, true);
        tree = string_of(ctx, tv, &tree_len);
        JS_FreeValue(ctx, tv);
        if (tree && tree_len > MAX_TREE_BYTES) {
            add_log(c, "the card's page is too large");
            stop(c, "output");
            free(tree);
            tree = NULL;
        } else if (tree) {
            // Only well-formed JSON leaves the card.
            JSValue check = JS_ParseJSON(ctx, tree, tree_len, "<tree>");
            if (JS_IsException(check) || !JS_IsArray(check)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                add_log(c, "the card's page could not be read");
                free(tree);
                tree = NULL;
            }
            JS_FreeValue(ctx, check);
        }
    }

    buf_str(&b, "{\"tree\":");
    if (tree) buf_put(&b, tree, tree_len);
    else buf_str(&b, "null");
    buf_str(&b, prevented > 0 ? ",\"prevented\":true" : ",\"prevented\":false");
    if (open) {
        buf_str(&b, ",\"open\":");
        buf_json_string(&b, open, strlen(open));
    }
    if (copy) {
        buf_str(&b, ",\"copy\":");
        buf_json_string(&b, copy, strlen(copy));
    }
    buf_str(&b, ",\"stopped\":");
    if (c->stopped) buf_json_string(&b, c->stopped, strlen(c->stopped));
    else buf_str(&b, "null");
    buf_str(&b, ",\"logs\":[");
    for (int i = 0; i < c->nlogs; i++) {
        if (i) buf_str(&b, ",");
        buf_json_string(&b, c->logs[i], strlen(c->logs[i]));
        free(c->logs[i]);
    }
    c->nlogs = 0;
    buf_str(&b, "]}");
    free(tree);
    free(open);
    free(copy);
    if (b.failed) {
        free(b.buf);
        return strdup("{\"tree\":null,\"prevented\":false,\"stopped\":\"memory\",\"logs\":[]}");
    }
    return b.buf;
}

static char *stopped_result(HonkCard *c) {
    (void)c;
    return finish(c, false, 0);
}

// MARK: API

HonkCard *honk_card_open(const char *load_json, const HonkCardLimits *limits, char **result) {
    *result = NULL;
    HonkCard *c = calloc(1, sizeof *c);
    if (!c) return NULL;
    c->limits = limits ? *limits : honk_card_default_limits();
    c->next = -1;
    for (int i = 0; i < FN_COUNT; i++) c->fns[i] = JS_UNDEFINED;
    c->rt = JS_NewRuntime2(&card_malloc_functions, c);
    if (!c->rt) {
        free(c);
        return NULL;
    }
    JS_SetMaxStackSize(c->rt, c->limits.stack);
    JS_SetInterruptHandler(c->rt, interrupt_handler, c);
    JS_SetCanBlock(c->rt, false);
    c->ctx = JS_NewContext(c->rt);
    if (!c->ctx) {
        JS_FreeRuntime(c->rt);
        free(c);
        return NULL;
    }
    c->window_start = now_ms();

    // runtime.js evaluates to its entry points; take them before any card code runs.
    begin(c, 1000);
    JSValue api = JS_Eval(c->ctx, (const char *)honk_card_runtime_js, honk_card_runtime_js_len, "runtime.js", JS_EVAL_TYPE_GLOBAL);
    c->deadline = 0;
    if (JS_IsException(api)) {
        handle_exception(c);
        add_log(c, "the card runtime failed to start");
        stop(c, "error");
    } else {
        for (int i = 0; i < FN_COUNT; i++) {
            c->fns[i] = own(c->ctx, api, FN_NAMES[i]);
            if (!JS_IsFunction(c->ctx, c->fns[i])) stop(c, "error");
        }
    }
    JS_FreeValue(c->ctx, api);

    // Load the page, then each script as a task of its own, then DOMContentLoaded and load.
    JSValue n = call(c, FN_LOAD, load_json, c->limits.task_ms);
    double count = 0;
    if (JS_IsNumber(n)) JS_ToFloat64(c->ctx, &count, n);
    JS_FreeValue(c->ctx, n);
    for (int i = 0; i < (int)count && i < 64 && !c->stopped; i++) {
        char idx[16];
        snprintf(idx, sizeof idx, "%d", i);
        call_void(c, FN_SCRIPT, idx);
    }
    call_void(c, FN_READY, NULL);
    *result = finish(c, false, 0);
    return c;
}

char *honk_card_click(HonkCard *c, const char *path_json) {
    if (c->stopped) return stopped_result(c);
    JSValue r = call(c, FN_CLICK, path_json, c->limits.task_ms);
    int prevented = JS_IsBool(r) ? JS_ToBool(c->ctx, r) : 0;
    JS_FreeValue(c->ctx, r);
    return finish(c, true, prevented);
}

char *honk_card_tick(HonkCard *c) {
    if (c->stopped) return stopped_result(c);
    call_void(c, FN_TICK, NULL);
    return finish(c, false, 0);
}

char *honk_card_set(HonkCard *c, const char *state_json) {
    if (c->stopped) return stopped_result(c);
    call_void(c, FN_SET, state_json);
    return finish(c, false, 0);
}

double honk_card_next(HonkCard *c) {
    if (c->stopped || c->next < 0) return -1;
    double left = c->next - (now_ms() - c->next_at);
    return left < 0 ? 0 : left;
}

void honk_card_close(HonkCard *c) {
    if (!c) return;
    for (int i = 0; i < FN_COUNT; i++) JS_FreeValue(c->ctx, c->fns[i]);
    for (int i = 0; i < c->nlogs; i++) free(c->logs[i]);
    JS_FreeContext(c->ctx);
    JS_FreeRuntime(c->rt);
    free(c);
}

void honk_card_free_string(char *s) { free(s); }
