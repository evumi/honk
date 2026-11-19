# Self-hosting a Honk gateway

[中文](SELF-HOSTING.zh-CN.md)

A gateway is one Go binary with one SQLite file. The Honk app talks only to its gateway, so you can point the app at yours (Settings, Gateway) and keep your bots, tokens and message queue on your own machine. This page covers running it with Docker Compose, putting HTTPS in front, how pushes reach your phone, backups and upgrades.

## 1. What you need

- A host with Docker and a public name for it, for example `honk.example.com`, with ports 80 and 443 reachable (a certificate needs them).
- The Honk app from the App Store or Google Play. You do **not** need Apple or Google credentials: see "Pushes and the relay".

## 2. Docker Compose

Create a directory with `docker-compose.yml`:

```yaml
services:
  honk:
    image: ghcr.io/evumi/honk-gateway:latest   # pin a version such as :0.2.0 once you have one you trust
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"                  # only the reverse proxy reaches it
    volumes:
      - honk-data:/data                        # the SQLite database
    environment:
      HONK_MESSAGE_TTL: 168h
      # HONK_REGISTER_KEY: choose-a-long-random-string   # only devices that know it can register
      # HONK_LOG_FORMAT: json
volumes:
  honk-data:
```

```bash
docker compose up -d
docker compose logs honk      # the log says how each platform pushes
curl http://127.0.0.1:8080/v1/info
```

`/healthz` answers `ok`; the image has a health check. `/` is the gateway's landing page and `/docs` its API docs, with your address in the examples; `HONK_SITE=false` turns both off. The repository's `gateway/docker-compose.yml` is the variant for a gateway that has its own APNs and FCM credentials (section 6).

## 3. Reverse proxy and TLS

The app needs HTTPS. Caddy gets and renews the certificate by itself; a `Caddyfile`:

```
honk.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

or as another service in the same compose file:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
```

(with `reverse_proxy honk:8080` and no `ports` on the `honk` service, and `caddy-data` under `volumes`). With nginx, proxy to `127.0.0.1:8080` and pass `X-Forwarded-For` or `X-Real-IP`: the gateway reads the client address from them for its per-IP rate limits (registration, pairing), but only when the connection comes from `HONK_TRUSTED_PROXIES` (default: loopback and private ranges, which covers a local proxy or a docker network; set it to your proxy's address, or `none` when nothing sits in front). A proxy that does not set them makes every client look like one address; headers from any other peer are ignored, so clients cannot spoof them. Bodies are small; nothing special is needed for timeouts.

Then, in the app: Settings, Gateway, enter `https://honk.example.com/`, "Test connection", and save. The app registers this device on your gateway, with the register key if you set one. Switching clears the bots and messages on the phone; they stay on the old gateway.

## 4. Pushes and the relay

APNs and FCM only deliver pushes signed with the credentials of the app that is installed. Your gateway does not have those credentials, so it uses a **push relay**: for each push it sends one HTTP request to the relay, by default the official gateway at `https://honk.bunship.site/`, which hands it to Apple or Google and tells your gateway what happened. Nothing else changes: the app talks to your gateway, and your gateway keeps the queue and every message.

What the relay sees (and what Apple and Google see through it):

- Sees: the push token and platform, the message id, bot id, notification level, a hash of the sender's `id`, your gateway's IP address and the request time. It stores none of this per push; it keeps a table of the gateways it relays for (an id, a hash of the key, timestamps) and in-memory rate-limit counters.
- Does not see, by default: the bot name, title, body, group, card, data and the sender's `id`. The push shows "New notification" until the app has fetched the message from your gateway, then the real text.

Set `HONK_PUSH_CONTENT=full` to put the bot name, title and body in relayed pushes too (they then pass through the relay, Apple and Google, as they do on the official gateway). Set `HONK_RELAY_URL=off` to turn the relay off: a platform without credentials then gets no pushes, and messages show up only when the app is opened (the Gateway page warns about this). `HONK_RELAY_URL` can also point at another relay you trust, or at your own (section 6).

The start-up log says it plainly:

```
level=WARN msg="no push credentials for ios: pushes go through the relay https://honk.bunship.site (push token, message id and bot id pass through it; banner text does not); set HONK_APNS_KEY_FILE to push directly or HONK_RELAY_URL=off to turn this off" platform=ios
```

The relay is a free convenience; it can refuse a gateway that misuses it (many pushes to dead tokens), and its operator sets the rate limits. See the [privacy policy](../PRIVACY.md).

## 5. Backups

Everything is in the SQLite file (`/data/honk.db`, in WAL mode), and it is a short-term queue: messages expire after `HONK_MESSAGE_TTL`. What you would miss after losing it is the device registrations, the bots and their tokens. Do not copy the file with `cp` while the gateway runs; use SQLite's online backup, which gives a consistent copy:

```bash
mkdir -p backup
docker run --rm -v honk_honk-data:/data -v "$PWD/backup:/backup" keinos/sqlite3 \
  sqlite3 /data/honk.db ".backup '/backup/honk-$(date +%F).db'"
```

(the volume is named `<project>_honk-data`; `docker volume ls` shows it). Run it from cron and keep a few copies. For continuous replication use [Litestream](https://litestream.io/): run it as a second container on the same `/data` volume with `litestream replicate /data/honk.db s3://bucket/honk`, and restore with `litestream restore`. To restore a `.backup` copy, stop the gateway and put the file at `/data/honk.db` (delete `honk.db-wal` and `honk.db-shm`).

## 6. Your own credentials, and running a relay

If you build your own app (your own bundle id, Apple team and Firebase project), give the gateway its credentials and it pushes directly, with the full text by default:

```yaml
    volumes:
      - honk-data:/data
      - ./secrets:/secrets:ro            # apns.p8, fcm.json
    environment:
      HONK_APNS_KEY_FILE: /secrets/apns.p8
      HONK_APNS_KEY_ID: ABC123DEFG
      HONK_APNS_TEAM_ID: ABCDE12345
      HONK_APNS_TOPIC: com.example.honk   # your bundle id
      HONK_FCM_CREDENTIALS_FILE: /secrets/fcm.json
```

Each platform is independent: with only the FCM file, Android pushes directly and iOS uses the relay. A gateway with credentials can also serve as a relay for others with `HONK_RELAY_SERVE=true` (limits: `HONK_RELAY_RATE`, `HONK_RELAY_BURST`, `HONK_RELAY_TOKEN_PER_MINUTE`); it refuses to start without credentials for at least one platform. It sends only with its own credentials, never on to another relay. A gateway that serves a relay does not use one itself. Block a gateway that misbehaves with `sqlite3 honk.db "UPDATE relays SET blocked = 1 WHERE id = '…'"`; the log names the gateway when it slows one down.

## 7. Upgrading

Update the apps first, then the gateway. New app builds work with an old gateway (they read `/v1/info`'s `features` and fall back), but an old app can fail against a new gateway when the API changed. The gateway migrates its database at start (`PRAGMA user_version`), one transaction per step, and there is no automatic way back: take a backup (section 5) first.

```bash
docker compose pull && docker compose up -d
docker compose logs --tail 20 honk
```

Watch `/metrics` if you turn it on (`HONK_METRICS_ADDR=0.0.0.0:9100` inside the container, published only on a private interface): `honk_pushes_total` by route and result shows whether pushes work.

## 8. Settings

All settings are environment variables; the table is in the [README](../README.md#running-the-gateway). The ones a self-hoster usually touches: `HONK_REGISTER_KEY` (keeps strangers from registering), `HONK_MESSAGE_TTL`, `HONK_RELAY_URL`, `HONK_PUSH_CONTENT`, `HONK_LOG_FORMAT`.
