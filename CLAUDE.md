# CLAUDE.md

Guidance for Claude Code in this repository.

## Layout

Monorepo. `gateway/` is the Go module `github.com/evumi/honk/gateway`; `app/` is the nsh UI, which `ios/` and `android/` host. The Go version is pinned in `mise.toml`; run Go through `mise exec -- go …` if `go` is not on PATH.

## Gateway

- `cd gateway && go test -race ./...` and `go vet ./...` before committing.
- `make run` starts it on :8080 with `./data/honk.db`; with no APNs/FCM credentials and `HONK_RELAY_URL=off` (the Makefile sets it, so a dev gateway never reaches the official relay), pushes are skipped.
- `cmd/honk` wires config, store, push and API. `internal/store` is SQLite through modernc (pure Go, no cgo) with one connection; the schema is `internal/store/schema.sql`, versioned with `PRAGMA user_version`. Add a new migration step for schema changes instead of editing v1 once it has shipped.
- Timestamps are Unix milliseconds; device ids are UUIDv7; message ids are SQLite integers. A bot's public id is 8 random base62 characters starting with a letter (`bots.public_id`, v2); the integer row id stays private. Never show users a sequence number as an id. A bot token is `<bot id>:<secret>`; only sha256 hashes of tokens and device secrets are stored, so pre-v2 `<integer>:<secret>` tokens still work.
- Pushes go through a bounded queue with workers and are retried after 2 s, 10 s and 60 s (`internal/api/pushq.go`). A pusher reports a failure worth retrying as `push.RetryableError` (APNs, FCM and any new pusher must); anything else is final. `internal/metrics` is the hand-written `/metrics` registry (`HONK_METRICS_ADDR`); new counters go through it, no new dependencies. New env vars go in `internal/config`, both READMEs and DESIGN.
- Pushes carry the banner text and `msg_id` only; devices fetch the message (card included) from the queue. Keep APNs/FCM payloads under 4 KB.
- `internal/widget` is the server-side card whitelist: static HTML/CSS (profile 1) plus inline classic `<script>`s (profile 2); `on*` handlers, `src`/module scripts and scripts whose text has `<!--`, `<script` or `</script` are removed. It mirrors Telegram's HTML widget limits: 32 KB raw, 4 KB zlib level 9, 1 KB data.
- Push relay: a platform without direct credentials pushes through `push.Relay` (`internal/push/relay.go`) to a relay gateway (`HONK_RELAY_URL`, default the official one, `off` to disable); `HONK_RELAY_SERVE` (`internal/api/relay.go`) makes a gateway that has credentials the relay, using only its direct pushers, never a relay. `config.PushRoute` says direct/relay/off per platform and feeds `/v1/info` `push`. `HONK_PUSH_CONTENT` (`Notification.Bare`) strips bot name, title, body, group and id from APNs/FCM payloads; a relayed push is bare by default, so the device builds the banner from the fetched message (`BannerText.choose` in HonkKit, `Banner.choose` in `:core`; keep them in step, with their tests). Relay and client share one wire format (`relayPushRequest` / `relayRequest`); change both and `docs/DESIGN.zh-CN.md` together. The `relays` and `meta` tables are schema v3.
- The bot API keeps Telegram's naming and `{"ok":…}` envelope; keep new methods consistent with it.

## iOS (ios/)

- `ios/HonkKit` is a Swift package shared by the app and the Notification Service Extension. `cd ios && make test` runs its swift-testing tests, also with only the Command Line Tools (the Makefile adds the Testing framework path). Tests use swift-testing, not XCTest, for that reason.
- The Xcode project is generated: `cd ios && make setup` fetches the nsh frameworks (`scripts/fetch-nsh-ios.sh`, sha256-checked) and runs XcodeGen on `project.yml`. Neither `Honk.xcodeproj` nor `Frameworks/` is committed. Team and gateway go in `Config/Local.xcconfig` (ignored).
- The app and the extension share the SQLite store (App Group) and credentials (keychain access group). `LocalStore.apply` must stay idempotent: the extension and a later sync both apply the same item.
- What a notification offers (actions, categories, tap target, silent, image rules) is decided in `HonkKit/NotificationPlan.swift` and mirrored in `:core`'s `NotificationPlan.kt` (same tests); the NSE, `AppDelegate` and Android `Notifier` only apply it. Keep the two in step.
- Entitlements are generated from `entitlements.properties` in `project.yml`; never leave only a `path` (XcodeGen then writes an empty dict). `make project` runs `scripts/check-entitlements.sh`.
- Background refresh is `ios/App/BackgroundRefresh.swift` (`BGAppRefreshTask`, id `<bundle id>.refresh`): keep the id in `project.yml`'s `BGTaskSchedulerPermittedIdentifiers`, and keep it sync-only (iOS shows no local notifications from it).
- Simulator builds are arm64 only (nsh ships no x86_64 simulator slice): `make sim` / `make run-sim`. Debug simulator builds without an APNs token register as `simulator-<uuid>` and poll; the gateway skips pushes to such tokens.

## Android (android/)

- Gradle, minSdk 26, GMS devices only (FCM data messages; no vendor push). `:core` is plain Kotlin/JVM and mirrors `ios/HonkKit`: `ApiClient`, `LocalStore` (over the `Sql` interface; `AndroidSql` in the app, JDBC in tests), `SyncEngine`, `DeviceRegistrar`. Keep `LocalStore`'s tables and `apply()` semantics in step with `LocalStore.swift`.
- `cd android && ./gradlew :core:test` needs only a JDK 17. The app needs the Android SDK (platform 35) and the nsh AARs: `scripts/fetch-nsh-android.sh` (sha256-checked) puts them in `app/libs` (ignored); `debug` links `nsh-dev.aar`, `release` `nsh.aar`. The build runs `scripts/build-nsh-bundle.sh` and ships `app/dist/nsh` as `assets/nsh`.
- Firebase config is `android/app/google-services.json` (ignored); without it the app builds but gets no FCM token. The gateway URL is `-Phonk.gatewayUrl=…`, `HONK_GATEWAY_URL` or `honk.gatewayUrl` in `android/local.properties` (default `http://10.0.2.2:8080/`, the emulator's host). Release builds read `HONK_VERSION_NAME`/`HONK_VERSION_CODE` and the signing key from `HONK_KEYSTORE_FILE`, `HONK_KEYSTORE_PASSWORD`, `HONK_KEY_ALIAS`, `HONK_KEY_PASSWORD`, falling back to the debug key.
- `SyncWorker` (WorkManager, every 6 h) runs the same `HonkService.refresh()` as "sync now"; it posts no notifications.
- nsh's `NshView` API: read the AAR's classes (`javap`) and https://nsh.dev/docs/android rather than guessing. Host replies go through org.json, which drops `null` map values: use `JSONObject.NULL`.
- A notification's tag is `c<bot>:<collapse id>` or `m<message id>`; LocalStore keeps it as the message's `notif_id`. One NotificationChannel per bot (`bot-<id>`).

## nsh app (app/)

- `cd app && nsh check App.tsx && nsh test`. With no host (`nsh run App.tsx` on a desktop) the app uses `src/demo.ts`.
- The host contract is `app/src/host.ts` on one side and `ios/App/NshBridge.swift` and `android/app/src/main/kotlin/dev/evumi/honk/NshBridge.kt` on the other; change all three together. `app/src/host.contract.json` holds sample arguments and results for every `honk.*` call and event: add or change the sample first, then `host.ts`, `demo.ts`, `HostContract.swift` (HonkKit: `CallArgs`, `HostArgs`, `HostJSON`) and `HostContract.kt` (`:core`: `Args`, `HostArgs`, `HostJson`); the bridges only wire those to `HonkService`. `nsh test` (`host.contract.test.ts`), `make test` in `ios/` and `:core:test` fail when any side drifts.
- Read the generated declarations in `app/.nsh/types` (created by `nsh init`/`nsh check`) for the nsh API; `calc(env(...))` is not valid for `top`/`bottom`, use `safeArea()`.
- `app/src/widget` renders cards. A card with `<script>` is run by the host (`honk.card.*`, see `native/`) and drawn from the trees it returns, always passed through `cleanTree` in `sanitize.ts` first. `<style>` rules are applied by `css.ts` (cascade, `@media (prefers-color-scheme)`, custom properties, 400 rules) with selectors from `selector.ts`. Keep its limits and CSS checks (`sanitize.ts`) in step with `gateway/internal/widget`.
- UI strings are written in Chinese and wrapped in `tr("…")` (`app/src/i18n.ts`); add the English to its `EN` table in the same change. The language follows `locale()`: Chinese for `zh*`, English otherwise. Tests pin `locale: "zh-Hans-CN"`.
- Pages hide the system header (`NavPage headerVisible={false}`) and draw their own: `TopBar` (floating glass back button, title pill, avatar or text action, over a blurred top edge) and `FormBody` (scrolling content, a footer button pinned above the home indicator and the keyboard) in `app/src/components.tsx`. Floating controls use `glass(p)`; icons are `Icon` with `UI_ICONS` (24-unit stroke paths), never text glyphs. The design canvas is the reference for layout.
- App Store images: `public/appstore/README.md` (regenerate with `scripts/brand/`).

## Card scripts (native/)

- `native/quickjs` is vendored quickjs-ng (engine core only, no quickjs-libc; see its `VERSION`). `native/card` is the sandbox shared by both apps: `honk_card.c` (one runtime per card, limits, checks on everything a card returns) and `runtime.js` (the DOM and `TelegramWidget` inside the card). After editing `runtime.js` run `make -C native runtime` (CI checks `runtime_js.h` is current).
- `make -C native test asan` runs the C tests; `cd native && swift test` the iOS `CardHost` (`native/swift`, with the Command Line Tools add the flags `ios/Makefile` uses); `cd android && ./gradlew :core:test` the Android `CardHost` through JNI (it builds `native/build/libhonkcard.*` with `make -C native jni`).
- iOS links the local package `native/Package.swift` (`project.yml`); Android builds `libhonkcard.so` from `native/jni/CMakeLists.txt` (`externalNativeBuild`). Keep `CardHost.swift` and `CardHost.kt` in step, and the `honk.card.*` calls in `host.ts` and both `NshBridge`s.

Docs come in pairs: update README.md and README.zh-CN.md together (and `docs/SELF-HOSTING.md` with `docs/SELF-HOSTING.zh-CN.md`). The design document is docs/DESIGN.zh-CN.md; keep it in step with the code.
