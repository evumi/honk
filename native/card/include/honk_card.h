// Card scripts in a sandbox: one QuickJS (quickjs-ng) runtime per card.
//
// Shared by the iOS app (bridging header) and the Android app (JNI). The
// hosts only keep cards on one background thread, call these functions and
// schedule `honk_card_tick` after `honk_card_next` milliseconds; every limit
// and check is here, so both platforms behave the same.
//
// A card gets the engine core only: no quickjs-libc, so no files, network,
// processes or timers of its own. runtime.js (embedded) gives it a small DOM,
// timers driven by ticks and window.TelegramWidget.
//
// Every call returns a JSON object (free it with honk_card_free_string):
//   {"tree": [...] | null,      the card's nodes when they changed since the last call
//    "prevented": bool,         click: a handler called preventDefault()
//    "open": "https://…",       click: a link to open (once per tap, https, ≤ 256 characters)
//    "copy": "…",               click: text to copy (once per tap, 1–256 characters)
//    "stopped": "time" | "memory" | "output" | "error" | null,
//    "logs": ["…"]}
// A stopped card keeps its last tree; later calls only return {"stopped": …}.
//
// Not thread-safe: use a card from one thread at a time.

#ifndef HONK_CARD_H
#define HONK_CARD_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HonkCard HonkCard;

typedef struct HonkCardLimits {
    /** The card's heap (default 8 MB, Telegram's). */
    unsigned long memory;
    /** The interpreter's stack (default 256 KB); the calling thread needs more than this. */
    unsigned long stack;
    /** Wall time of one task: the scripts at load, a tick, a tap (default 200 ms). */
    int task_ms;
    /** Script time per second; past it ticks wait for the next second (default 300 ms, Telegram's). */
    int cpu_per_second_ms;
} HonkCardLimits;

/** The defaults above. */
HonkCardLimits honk_card_default_limits(void);

/**
 * Starts a card. `load_json` is {"tree": [nodes], "data": "<the message's data>",
 * "theme": {"--tg-theme-…": "#…", "--tg-color-scheme": "light" | "dark"},
 * "language": "en", "active": true}; nodes are
 * {"type": "element", "tag", "attrs": {…}, "children": [...]} or {"type": "text", "text"}.
 * Runs the inline scripts, then DOMContentLoaded and load.
 * Returns the card (NULL only when no runtime could be made) and sets *result.
 */
HonkCard *honk_card_open(const char *load_json, const HonkCardLimits *limits, char **result);

/** A tap on the element at `path_json`, child indexes from the root: "[0, 2]". */
char *honk_card_click(HonkCard *card, const char *path_json);

/** Runs the timers that are due. */
char *honk_card_tick(HonkCard *card);

/** {"theme": {…}} and/or {"active": bool}: fires themeChanged, activated or deactivated. */
char *honk_card_set(HonkCard *card, const char *state_json);

/** Milliseconds until the next tick is due; negative when there is none (or the card stopped). */
double honk_card_next(HonkCard *card);

/** Bytes the card's runtime holds now (at most the memory limit); hosts use it for a budget across cards. */
unsigned long honk_card_memory(HonkCard *card);

void honk_card_close(HonkCard *card);

void honk_card_free_string(char *s);

#ifdef __cplusplus
}
#endif

#endif
