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

Queued messages expire after 7 days; a message that every device of the group has acked is deleted a day after it was created (`HONK_ACKED_KEEP`).

A push that fails for a reason that may pass (a network error, a timeout, a 5xx, a 429 with its `retry_after`) is retried from a bounded in-memory queue after 2 s, 10 s and 60 s, four attempts in all; it is dropped when that device has acked the message or its push token changed meanwhile. Retries are not kept across a restart: the device still gets the message from `/v1/sync`. The apps also sync in the background about every six hours (iOS `BGAppRefreshTask`, Android WorkManager), which applies edits and deletes and updates the badge but never posts notifications.

## Several phones: device groups

A phone is not tied to its bots: devices that were paired form a **device group**, which shares the bots and the queue. Every message is pushed to every device of the group that can take a push (edits and deletes too), and each device keeps its own sync cursor and ack watermark, so a slow phone never loses a message to a fast one. A message leaves the queue when it has expired, or when every device of the group has acked it and it is older than `HONK_ACKED_KEEP`. Muting, pinning and read state stay on each phone; older local history does not move (only what is still queued does).

To switch phones or add one, open Settings → Devices → Add device on the old phone: it shows a 26-character pairing code (16 random bytes in Crockford base32, grouped in fours; nsh has no QR code API, so it is text only, with a copy button). On the new phone use "Already have a device? Enter a pairing code" (Settings, or the empty home screen). The code is good for 10 minutes and works once; the gateway never sees it, only a `link_id` and the bot tokens encrypted with a key, both derived from the code with HKDF-SHA256. The new phone's own bots, if it had any, join the group too. Claims are limited per client IP, so a code cannot be guessed. There is no recovery for a lost phone with no other device: bot tokens only exist on devices and in the groups' senders, so create the bots again.

Settings → Devices lists the group (name, platform, last seen, this device); a device can be removed from there. Data has two buttons: "Remove this device from the group" (this phone leaves, the bots stay with the others) and "Delete all data" (the whole group's devices, bots and queue on the gateway, then this phone). A device whose push token has been rejected and that has made no request for `HONK_DEVICE_GC` (90 days) is deleted by the gateway, together with the bots and queue when it was the last device of its group.

## Running the gateway

Hosting your own gateway: see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) (Docker Compose, reverse proxy and TLS, backups, upgrades).

```bash
cd gateway
make run        # works without push credentials (relay off): pushes are skipped
make test
```

See `gateway/Dockerfile` for the container. Settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `HONK_ADDR` | `:8080` | listen address |
| `HONK_DB` | `./data/honk.db` | SQLite file |
| `HONK_MESSAGE_TTL` | `168h` | how long a message stays queued |
| `HONK_ACKED_KEEP` | `24h` | how long a message that every device of the group has acked is kept (counted from its creation) |
| `HONK_DEVICE_GC` | `2160h` | a device whose push token is gone and that made no request for this long is deleted, with the group's bots and queue if it was the last |
| `HONK_SEND_RATE` / `HONK_SEND_BURST` | `5` / `20` | per-bot messages per second / burst |
| `HONK_REGISTER_PER_HOUR` | `10` | device registrations per client IP per hour (burst 5) |
| `HONK_MAX_BOTS_PER_DEVICE` | `100` | bots one device group can own (the name is from before groups); a pairing that would exceed it is refused |
| `HONK_APNS_KEY_FILE` | | APNs `.p8` key; iOS push is off without it |
| `HONK_APNS_KEY_ID` / `HONK_APNS_TEAM_ID` / `HONK_APNS_TOPIC` | | required with the key; the topic is the bundle ID |
| `HONK_APNS_SANDBOX` | `false` | use the APNs development gateway (debug builds) |
| `HONK_FCM_CREDENTIALS_FILE` | | Firebase service account JSON; Android push is off without it |
| `HONK_PUSH_QUEUE` / `HONK_PUSH_WORKERS` | `1024` / `16` | pushes that may wait in the queue (a full queue drops and counts) / pushes in flight at once |
| `HONK_RELAY_URL` | `https://honk.bunship.site/` | the push relay a platform without direct credentials uses; `off` turns it off (that platform then gets no pushes). See [Push relay](#push-relay) |
| `HONK_RELAY_SERVE` | `false` | serve `/v1/relay/*` for other gateways; refuses to start unless at least one platform has direct credentials |
| `HONK_PUSH_CONTENT` | `full` direct, `none` through a relay | `full` puts the bot name, title and body in the push, `none` only ids (APNs shows "New notification" until the device fetches the message). Set it to choose for both routes |
| `HONK_RELAY_RATE` / `HONK_RELAY_BURST` | `10` / `100` | relay side: pushes per second / burst per relayed gateway |
| `HONK_RELAY_TOKEN_PER_MINUTE` | `60` | relay side: pushes per push token per minute |
| `HONK_REGISTER_KEY` | | when set, `POST /v1/devices` must carry the same `register_key`; `/v1/info` then reports `register_key_required`. The app's Gateway page has an optional register key field |
| `HONK_METRICS_ADDR` | | e.g. `127.0.0.1:9100`: serves Prometheus text at `/metrics` on its own listener; off when empty |
| `HONK_LOG_FORMAT` | `text` | `json` for structured logs |
| `HONK_LOG_LEVEL` | `info` | `debug` also logs every request (the bot token in the path is hidden) |

`/metrics` has `honk_messages_total{kind}`, `honk_pushes_total{platform,route,result}` (`route` `direct` or `relay`; `ok`, `retry`, `token_gone`, `failed`), `honk_relay_requests_total{result}` and `honk_relay_pushes_total{platform}` on a relay, `honk_push_retries_total`, `honk_push_dropped_total{reason}`, `honk_http_requests_total{class}`, and the gauges `honk_devices`, `honk_bots` and `honk_push_queue_length`.

## Push relay

APNs and FCM only accept pushes signed with the credentials of the published app, so a self-hosted gateway has none of its own. Without credentials for a platform, the gateway sends each push as one HTTP request to a relay (by default the official gateway at `https://honk.bunship.site/`), which passes it to APNs or FCM and answers with the result. The app still talks only to your gateway, and registration is unchanged. The start-up log says which route each platform uses.

1. A sender calls `sendMessage` on your gateway, which keeps the queue and the content.
2. Your gateway sends the push token, `msg_id`, bot id, level and a hashed collapse key to the relay.
3. The relay sends the push to APNs/FCM and wakes the device.
4. The device fetches `GET /v1/messages/:id` from your gateway and builds the banner from it.

By default a relayed push carries **no content** (`HONK_PUSH_CONTENT=none`): no bot name, title or body, and the sender's `id` only as a hash. iOS shows the localised "New notification" until the extension has fetched the message, then the real text; Android does the same from the fetched message. With `HONK_PUSH_CONTENT=full` the bot name, title and body (cut to the usual banner length) go through the relay and Apple/Google as they do on a direct push. The relay does not store pushes; it keeps a table of registered gateways (id, a hash of the key, timestamps, `blocked`) and in-memory counters.

Protocol (Telegram's `{"ok":…}` envelope):

- `POST /v1/relay/gateways` registers a gateway without any account and returns `relay_id` and `relay_key` once; the gateway keeps them in its `meta` table. Limited per client IP like device registration.
- `POST /v1/relay/push` with `Authorization: Bearer <relay_key>` and JSON `platform`, `token`, `kind`, `msg_id`, `target_id`, `bot_id`, `level`, `collapse_key` (and `bot_name`, `title`, `body`, `group` for `full`). Body at most 8 KB.
- Answers: 200 sent; 410 the token is gone (the gateway marks it, as for a direct push); 429 with `parameters.retry_after` (retried by the push queue); 401 unknown or blocked key (not retried; an unknown key makes the gateway register again, at most once an hour, a blocked one does not); 503 the relay has no credentials for the platform (not retried); 5xx and network errors are retried.

Serving a relay: set `HONK_RELAY_SERVE=true` next to your own credentials. It sends through its direct credentials only and never forwards to another relay. Each relayed gateway and each push token is rate limited; a gateway that sends over 100 dead tokens in an hour, more than half of its pushes, is slowed down and logged, and a relay can be blocked with `UPDATE relays SET blocked = 1 WHERE id = '…'`. `/v1/info` reports `features: ["relay"]`, and every gateway reports `push: {"ios","android"}` as `direct`, `relay` or `off`; the app's Gateway page shows it when you test a gateway.

## Bot API

`/bot<token>/<method>`, parameters in the query string, a form or JSON. Responses use Telegram's envelope: `{"ok":true,"result":…}` or `{"ok":false,"error_code":400,"description":"…"}`.

- `sendMessage`: `body` (required, 4096 characters; the banner text and the fallback for clients without cards), `title`, `html` (card: 32 KB raw, 4 KB after zlib), `data` (1 KB, fills `{{key}}` placeholders), `level` (`passive` \| `active` \| `timeSensitive`), `group`, `id` (a later message with the same id replaces this one), `url`, `copy`, `icon` (https).
- `sendMessage` also takes `dry_run` (`true`): validate only. Nothing is queued or pushed; the result is `{"dry_run":true,"html":<cleaned card>,"input_size","raw_size","compressed_size","removed":[…]}` with the sizes of the cleaned card (limits 32768 and 4096) and what the whitelist removed (`"onclick on <div>"`, `"<iframe>"`). It counts against the rate limit.
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

## Command line

The gateway binary is also a sender tool. `honk` with no arguments (or `honk serve`) runs the gateway exactly as before; the other subcommands talk to a gateway as one bot:

```bash
export HONK_URL=https://honk.example.com HONK_TOKEN=aZ3kQ9xT:Gw2K7mx…
honk send "backup finished" --title Backup --level passive
make 2>&1 | tail -5 | honk send --title "Build log"        # stdin is the body when piped
honk send "api v1.8.2 is live" --html @card.html --data @data.json --id deploy-api
honk edit --id deploy-api --data '{"status":"rolled back"}'
honk delete --id deploy-api
honk me                                                     # the bot behind the token
honk preview card.html --data data.json --watch             # resend on every save
```

- `HONK_URL` and `HONK_TOKEN` can also come from `--server` / `--token`, or from `~/.config/honk/config.json` (`{"url": "…", "token": "…"}`; `$XDG_CONFIG_HOME` and `$HONK_CONFIG` are honoured). Flags beat the environment, which beats the file.
- `send` flags: `--title`, `--body` (or the arguments, or stdin), `--html`, `--data` (both accept `@file`), `--id`, `--level`, `--group`, `--link` (the `url` parameter), `--copy`, `--icon`, `--dry-run`.
- `preview` sends with a fixed `id` (default `honk-preview`) and `level=passive`, so the message on the phone is replaced in place and stays quiet. It runs a `dry_run` first and prints the sizes and what the whitelist removed. See the [card cookbook](docs/CARDS.md).
- Exit status is 0 on success, 1 when the gateway or the network fails (the gateway's `description` is printed to stderr) and 2 for a usage error.
- `--key <base64 key>` (or `HONK_KEY`) encrypts the message content on the client: title, body, html, data, url, copy and icon go into one AES-256-GCM ciphertext (12-byte nonce, ciphertext, 16-byte tag, unpadded base64url; the bot id before the `:` of the token is the authenticated additional data), sent as `ciphertext`, while `level`, `group` and `id` stay plain. **The gateway does not accept `ciphertext` yet**; this is the sender side of the end-to-end encryption planned for a later release, so do not use `--key` against today's gateway.

## Connect existing tools

`/bot<token>/hook/<kind>` accepts the webhook payload of other tools and turns it into a message. It uses the same token, rate limit and validation as `sendMessage`. Put the URL, with the token in it, where the tool asks for a webhook URL. A payload with nothing to show (GitHub's `ping`, an Alertmanager group without alerts) answers `{"ok":true,"result":{"ignored":true}}` and sends nothing. `level`, `group`, `icon`, `copy`, `url` and `title` in the query string override what the adapter chose (`…/hook/github?level=passive`).

| `kind` | Source | What you get |
| --- | --- | --- |
| `slack` | Slack incoming-webhook payloads (`text`, `attachments`, section `blocks`) | the text as the body; the first attachment's title and `title_link` as title and link; `<url\|label>` becomes `label` |
| `alertmanager` | Alertmanager `webhook_configs` (version 4) | title `[FIRING:n] name`; one line per alert; `groupKey` becomes the message `id`, so "resolved" replaces "firing" in place; critical alerts are `timeSensitive`, resolved ones `passive`; a status card is attached |
| `grafana` | Grafana webhook contact point | the same layout; a single alert's `fingerprint` is the `id`, otherwise the `groupKey` |
| `github` | repository webhooks (JSON content type), event from `X-GitHub-Event` | `workflow_run` (one message per workflow and branch: queued, running and finished replace each other, failures are `timeSensitive`), `release`, `issues`, `pull_request`, `push`; other events get a one-line summary |
| `bark` | what a Bark client sends | set the Bark server to `https://honk.example.com/bot<token>/hook/bark`; `/<key>/<body>`, `/<key>/<title>/<body>`, `/<key>/<title>/<subtitle>/<body>` (the key is ignored) and `POST /push` with JSON or form fields `title`, `subtitle`, `body`, `level`, `group`, `url`, `copy`, `icon`, `id`; sound, badge and the like are dropped |
| `json` | any JSON | the query maps fields to paths: `?title=$.alert.name&body=$.message&group=ci`. Paths are `$.a.b`, `$.items[0].name` or `$.items.0.name`; a value without `$` is used as written; without `body` the JSON itself is the body |

The GitHub adapter does not check `X-Hub-Signature-256`: the token in the URL is the secret, so keep it out of public logs. In a GitHub Actions workflow use the action in this repository instead:

```yaml
- uses: evumi/honk@v1
  if: failure()
  with:
    url: ${{ secrets.HONK_URL }}
    token: ${{ secrets.HONK_TOKEN }}
    title: "${{ github.repository }}: build failed"
    body: "${{ github.workflow }} on ${{ github.ref_name }}"
    id: ci-${{ github.workflow }}
    level: timeSensitive
```

Inputs: `token`, `url` (required), `title`, `body` (defaults to the title), `id`, `level`, `html`, `data`. The action is a composite action that runs `curl` and fails the step when the gateway refuses the message.

## App API

Everything except device registration needs `Authorization: Bearer <device_secret>`.

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/info` | `{"name":"honk","version","api":2,"features":[…],"push":{"ios","android"}}` (`features` has `link` when device groups and pairing are available, `relay` on a relay) (`direct`, `relay` or `off`), plus `register_key_required` when `HONK_REGISTER_KEY` is set |
| `POST /v1/devices` | `{"platform":"ios"\|"android","push_token":"…","name":"…","register_key":"…"}` (`name` optional, at most 64 characters: the phone's name or model; the key only when the gateway asks for one) → `device`, `device_secret`. Each new device starts as a group of its own |
| `GET` / `PUT` / `DELETE /v1/devices/me` | read; update the push token and/or `name`; remove this device from its group (the last device takes the group, its bots and queue with it). `DELETE /v1/devices/me?all=true` deletes the whole group: every device, bot and queued message (the app's "Delete all data") |
| `GET /v1/devices` | the group's devices: `id`, `name`, `platform`, `seen_at` (Unix ms, written at most hourly), `current` |
| `DELETE /v1/devices/:id` | remove one device of the group (404 for one that is not in it) |
| `POST /v1/links` | `{"link_id","bundle"}`: store a pairing bundle (opaque base64url, at most 16 KB; `link_id` 16 to 64 base64url characters) for 10 minutes, one active link per group → `expires_in` seconds; 409 when the `link_id` is taken |
| `POST /v1/links/claim` | `{"link_id"}` from the new device: merges its whole group (devices, bots, queued messages) into the group that made the link and returns `bundle`. Works once; 404 for an unknown, expired or used link; 400 when the merged group would exceed the bot limit; 429 after too many attempts from one IP (burst 5, then 10 an hour) |
| `GET` / `POST /v1/bots` | list; create with `{"name","avatar","default_level"}` → `bot`, `token`. `avatar` is `preset:<icon>:<#rrggbb>`, an https URL, or `local:<file>` for an image the user picked in the app, which stays on the phone (the gateway stores only the name) |
| `GET` / `PATCH` / `DELETE /v1/bots/:id` | read, change, delete a bot (`:id` is the short bot id) |
| `POST /v1/bots/:id/token` | reset the token; the old one stops working |
| `GET /v1/messages/:id` | one queued item: `message`, `edit` or `delete` |
| `GET /v1/sync?cursor=&limit=` | items after the cursor → `messages`, `cursor`, `has_more` |
| `POST /v1/ack` | `{"up_to": <id>}`: everything up to that id is stored on this device (each device of a group has its own watermark, which never goes down) |

An `edit` or `delete` names its message by `target_id` and/or `id`. The message may already be gone from the queue, so the client applies it to its local copy.
