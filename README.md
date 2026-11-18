# Honk

[中文](README.zh-CN.md)

![Honk: chat list, a chat with cards, new bot, bot settings](docs/screenshots/en.png)

Honk is a push notification service built around bots: each bot is its own channel, and a message can carry a small HTML card in the format of Telegram's HTML widgets (Bot API 10.4). iOS receives pushes through APNs; Android through FCM (GMS devices only).

## Layout

| Directory | Contents | Status |
| --- | --- | --- |
| `gateway/` | Go + SQLite gateway: bot API, app API, short-term queue, APNs/FCM push | first version |
| `app/` | nsh app (TSX): chat list, message stream, card rendering | first version |
| `ios/` | Swift host, Notification Service Extension, shared HonkKit package | first version; built for the simulator in CI (`iosapp` job), not yet verified on a real device |
| `android/` | Kotlin host embedding the nsh app, FirebaseMessagingService, shared `:core` module (gateway client, local store, sync) | first version; `:core` tested on the JVM, the app built in CI (`android` job), not yet verified on a real device |

The development design (Chinese) is [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md); mockups and screenshots are in [docs/design](docs/design/).

## How it works

1. The app registers its APNs/FCM push token and gets a `device_secret`.
2. The app creates a bot and gets its token, `<bot id>:<secret>`, for example `aZ3kQ9xT:Gw2K7mx…`. A bot id is 8 random base62 characters starting with a letter, never a sequence number.
3. A sender calls `/bot<token>/sendMessage`. The gateway queues the message and sends a push with the banner text and the `msg_id` only.
4. On the device, the Notification Service Extension (iOS) or FCM service (Android) fetches `GET /v1/messages/:id`, card included, and stores it locally.
5. When the app opens it calls `GET /v1/sync` for anything missed, then `POST /v1/ack`.

Queued messages expire after 7 days; acked ones are deleted a day after the ack.

A push that fails for a reason that may pass (a network error, a timeout, a 5xx, a 429 with its `retry_after`) is retried from a bounded in-memory queue after 2 s, 10 s and 60 s, four attempts in all; it is dropped when the device has acked the message or its push token changed meanwhile. Retries are not kept across a restart: the device still gets the message from `/v1/sync`. The apps also sync in the background about every six hours (iOS `BGAppRefreshTask`, Android WorkManager), which applies edits and deletes and updates the badge but never posts notifications.

## Running the gateway

```bash
cd gateway
make run        # works without push credentials: pushes are logged and skipped
make test
```

See `gateway/Dockerfile` for the container. Settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HONK_ADDR` | `:8080` | listen address |
| `HONK_DB` | `./data/honk.db` | SQLite file |
| `HONK_MESSAGE_TTL` | `168h` | how long a message stays queued |
| `HONK_ACKED_KEEP` | `24h` | how long an acked message is kept |
| `HONK_SEND_RATE` / `HONK_SEND_BURST` | `5` / `20` | per-bot messages per second / burst |
| `HONK_REGISTER_PER_HOUR` | `10` | device registrations per client IP per hour (burst 5) |
| `HONK_MAX_BOTS_PER_DEVICE` | `100` | bots one device can own |
| `HONK_APNS_KEY_FILE` | | APNs `.p8` key; iOS push is off without it |
| `HONK_APNS_KEY_ID` / `HONK_APNS_TEAM_ID` / `HONK_APNS_TOPIC` | | required with the key; the topic is the bundle ID |
| `HONK_APNS_SANDBOX` | `false` | use the APNs development gateway (debug builds) |
| `HONK_FCM_CREDENTIALS_FILE` | | Firebase service account JSON; Android push is off without it |
| `HONK_PUSH_QUEUE` / `HONK_PUSH_WORKERS` | `1024` / `16` | pushes that may wait in the queue (a full queue drops and counts) / pushes in flight at once |
| `HONK_REGISTER_KEY` | | when set, `POST /v1/devices` must carry the same `register_key`; `/v1/info` then reports `register_key_required`. The app's Gateway page has an optional register key field |
| `HONK_METRICS_ADDR` | | e.g. `127.0.0.1:9100`: serves Prometheus text at `/metrics` on its own listener; off when empty |
| `HONK_LOG_FORMAT` | `text` | `json` for structured logs |
| `HONK_LOG_LEVEL` | `info` | `debug` also logs every request (the bot token in the path is hidden) |

`/metrics` has `honk_messages_total{kind}`, `honk_pushes_total{platform,route,result}` (`ok`, `retry`, `token_gone`, `failed`), `honk_push_retries_total`, `honk_push_dropped_total{reason}`, `honk_http_requests_total{class}`, and the gauges `honk_devices`, `honk_bots` and `honk_push_queue_length`.

## Bot API

`/bot<token>/<method>`, parameters in the query string, a form or JSON. Responses use Telegram's envelope: `{"ok":true,"result":…}` or `{"ok":false,"error_code":400,"description":"…"}`.

- `sendMessage`: `body` (required, 4096 characters; the banner text and the fallback for clients without cards), `title`, `html` (card: 32 KB raw, 4 KB after zlib), `data` (1 KB, fills `{{key}}` placeholders), `level` (`passive` \| `active` \| `timeSensitive`), `group`, `id` (a later message with the same id replaces this one), `url`, `copy`, `icon` (https).
- `editMessageData`: `message_id` or `id`, and `data`. Updates the card silently.
- `deleteMessage`: `message_id` or `id`. Removes the message and its notification.
- `getMe`: the bot.

Gateways before short bot ids (database schema v1) gave bots integer ids, so their tokens look like `4:Gw2K7mx…`. Upgrading gives every bot a short id; the old tokens keep working until they are reset, and a reset token starts with the short id. The app moves each bot's local messages and settings to its new id the first time it syncs, using the stored token to ask `getMe` which bot it is, or matching its creation time and name when it has no token; if the gateway can't be reached, it keeps the bot and tries again later. Update the apps before the gateway: older app builds cannot read short ids (`/v1/info` reports `api` 2), while new builds also work with an old gateway.

Card HTML keeps whitelisted elements: text and structure, tables, `details`, `button`, `a`, `style`, `img` with `data:` images, inline SVG, and inline `<script>` (profile 2, below). It removes external and module scripts, `on*` handlers, form controls, external resources (links other than `https://`, `#id` or `{{key}}`) CSS that loads anything (`@import`, `expression()`, `url()` other than `data:` images), and SVG attribute values with a `url()` other than `url(#id)` or a CSS escape (`\`). The client applies its own CSS whitelist when rendering.

The app draws inline SVG (`svg`, `g`, shapes, `text`/`tspan`, gradients, `symbol`/`use`) as an image: it writes the sanitized subtree back out as SVG markup, keeping only whitelisted elements and attributes, `use` references within the card (`#id`) and `url(#id)` paint, and rasterizes it. Its size comes from CSS, else the `width` and `height` attributes (`width="100%"` fills the card's width; `height` in px), else the `viewBox` ratio; `preserveAspectRatio` (including `none`) sets how it fills that box. `{{key}}`, `var()` and `currentColor` are resolved before drawing; `<style>` rules do not reach inside the SVG, so give its elements attributes or fixed colours. A `<title>` or `aria-label` becomes its accessibility label. Older apps skip inline SVG.

Cards can be styled as Telegram widgets are, with `<style>` blocks as well as `style=""`: type, `.class`, `#id` and attribute selectors, compounds (`div.card`), descendant, child (`>`) and sibling (`+`, `~`) combinators, `:first-child` / `:last-child` / `:nth-child()`, `:root` (also `html` and `body`), and several selectors per rule, with the usual specificity and order; inline style wins unless a rule is `!important`. Custom properties (`--x` on `:root` or any element, read with `var()`), the theme's `--tg-theme-*` variables, `light-dark()` and `@media (prefers-color-scheme: dark)` follow the app's appearance; `display: none` hides an element. `{{key}}` works inside `<style>` and in `class`. The first 400 rules apply; other media queries, `@keyframes`, pseudo-elements and `:hover` are ignored.

Cards can carry inline scripts, as Telegram's HTML widgets do (card profile 2). The iOS and Android apps run each card's scripts in a QuickJS runtime of its own ([quickjs-ng](https://github.com/quickjs-ng/quickjs), `native/`) on a background thread, with no network or files, 8 MB of memory and 200 ms per task; past that the card stops and keeps what it last drew. `window.TelegramWidget` gives `chatData` (the message's `data`), `themeParams`, `colorScheme`, `onEvent('themeChanged' | 'activated' | 'deactivated', …)`, and `openLink(url)` / `copyText(text)` from a tap handler. Scripts change the card through a small DOM (`getElementById`, `querySelector`, `textContent`, `innerHTML`, `classList`, `style`, `dataset`, `createElement`, `addEventListener('click', …)`) and have timers and a 4 KB `localStorage`; the app draws what they produce through the same whitelist. `request(data)` (1–64 bytes, from a tap handler, once per tap) sends a query to the bot and returns a Promise for its answer when the message allows queries (`allow_queries`); it rejects with a `WidgetRequestError` (`NOT_ALLOWED`, `INVALID_DATA`, `TOO_MANY_REQUESTS`, `TIMEOUT` after 15 s) otherwise. Older apps, and the desktop demo, show the static card with `{{key}}` filled in. The gateway keeps inline scripts and removes external and module scripts. Example:

```html
<p id="n">{{count}}</p><button id="b">+1</button>
<script>
  let n = Number(JSON.parse(TelegramWidget.chatData).count);
  document.getElementById("b").addEventListener("click", () => {
    document.getElementById("n").textContent = String(++n);
  });
</script>
```

## App API

Everything except device registration needs `Authorization: Bearer <device_secret>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/info` | `{"name":"honk","version","api":2}`, plus `register_key_required` when `HONK_REGISTER_KEY` is set |
| `POST /v1/devices` | `{"platform":"ios"\|"android","push_token":"…","register_key":"…"}` (the key only when the gateway asks for one) → `device`, `device_secret` |
| `GET` / `PUT` / `DELETE /v1/devices/me` | read; update the push token; delete with all bots and messages (the app's Settings, "Delete this device's data", calls it and then clears the phone) |
| `GET` / `POST /v1/bots` | list; create with `{"name","avatar","default_level"}` → `bot`, `token`. `avatar` is `preset:<icon>:<#rrggbb>`, an https URL, or `local:<file>` for an image the user picked in the app, which stays on the phone (the gateway stores only the name) |
| `GET` / `PATCH` / `DELETE /v1/bots/:id` | read, change, delete a bot (`:id` is the short bot id) |
| `POST /v1/bots/:id/token` | reset the token; the old one stops working |
| `GET /v1/messages/:id` | one queued item: `message`, `edit` or `delete` |
| `GET /v1/sync?cursor=&limit=` | items after the cursor → `messages`, `cursor`, `has_more` |
| `POST /v1/ack` | `{"up_to": <id>}`: everything up to that id is stored on the device |

An `edit` or `delete` names its message by `target_id` and/or `id`. The message may already be gone from the queue, so the client applies it to its local copy.
