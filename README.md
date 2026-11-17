# Honk

[中文](README.zh-CN.md)

Honk is a push notification service built around bots: each bot is its own channel, and a message can carry a small HTML card in the format of Telegram's HTML widgets (Bot API 10.4). iOS receives pushes through APNs; Android through FCM (GMS devices only).

## Layout

| Directory | Contents | Status |
| --- | --- | --- |
| `gateway/` | Go + SQLite gateway: bot API, app API, short-term queue, APNs/FCM push | first version |
| `app/` | nsh app (TSX): chat list, message stream, card rendering | first version |
| `ios/` | Swift host, Notification Service Extension, shared HonkKit package | first version (not yet built in Xcode) |
| `android/` | Kotlin host embedding the nsh app, FirebaseMessagingService, shared `:core` module (gateway client, local store, sync) | first version (`:core` tested on the JVM; the app is not yet built with the Android SDK) |

The development design (Chinese) is [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md); mockups and screenshots are in [docs/design](docs/design/).

## How it works

1. The app registers its APNs/FCM push token and gets a `device_secret`.
2. The app creates a bot and gets its token, `<bot id>:<secret>`, for example `aZ3kQ9xT:Gw2K7mx…`. A bot id is 8 random base62 characters starting with a letter, never a sequence number.
3. A sender calls `/bot<token>/sendMessage`. The gateway queues the message and sends a push with the banner text and the `msg_id` only.
4. On the device, the Notification Service Extension (iOS) or FCM service (Android) fetches `GET /v1/messages/:id`, card included, and stores it locally.
5. When the app opens it calls `GET /v1/sync` for anything missed, then `POST /v1/ack`.

Queued messages expire after 7 days; acked ones are deleted a day after the ack.

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

## Bot API

`/bot<token>/<method>`, parameters in the query string, a form or JSON. Responses use Telegram's envelope: `{"ok":true,"result":…}` or `{"ok":false,"error_code":400,"description":"…"}`.

- `sendMessage`: `body` (required, 4096 characters; the banner text and the fallback for clients without cards), `title`, `html` (card: 32 KB raw, 4 KB after zlib), `data` (1 KB, fills `{{key}}` placeholders), `level` (`passive` \| `active` \| `timeSensitive`), `group`, `id` (a later message with the same id replaces this one), `url`, `copy`, `icon` (https).
- `editMessageData`: `message_id` or `id`, and `data`. Updates the card silently.
- `deleteMessage`: `message_id` or `id`. Removes the message and its notification.
- `getMe`: the bot.

Gateways before short bot ids (database schema v1) gave bots integer ids, so their tokens look like `4:Gw2K7mx…`. Upgrading gives every bot a short id; the old tokens keep working until they are reset, and a reset token starts with the short id. The app moves each bot's local messages and settings to its new id the first time it syncs, using the stored token to ask `getMe` which bot it is. Update the apps before the gateway: older app builds cannot read short ids, while new builds also work with an old gateway.

Card HTML (profile v1) keeps whitelisted elements: text and structure, tables, `details`, `button`, `a`, `style`, `img` with `data:` images, and inline SVG. It removes scripts, `on*` handlers, form controls, external resources (links other than `https://`, `#id` or `{{key}}`) and CSS that loads anything (`@import`, `expression()`, `url()` other than `data:` images). The client applies its own CSS whitelist when rendering.

## App API

Everything except device registration needs `Authorization: Bearer <device_secret>`.

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/devices` | `{"platform":"ios"\|"android","push_token":"…"}` → `device`, `device_secret` |
| `GET` / `PUT` / `DELETE /v1/devices/me` | read; update the push token; delete with all bots and messages |
| `GET` / `POST /v1/bots` | list; create with `{"name","avatar","default_level"}` → `bot`, `token` |
| `GET` / `PATCH` / `DELETE /v1/bots/:id` | read, change, delete a bot (`:id` is the short bot id) |
| `POST /v1/bots/:id/token` | reset the token; the old one stops working |
| `GET /v1/messages/:id` | one queued item: `message`, `edit` or `delete` |
| `GET /v1/sync?cursor=&limit=` | items after the cursor → `messages`, `cursor`, `has_more` |
| `POST /v1/ack` | `{"up_to": <id>}`: everything up to that id is stored on the device |

An `edit` or `delete` names its message by `target_id` and/or `id`. The message may already be gone from the queue, so the client applies it to its local copy.
