# CLAUDE.md

Guidance for Claude Code in this repository.

## Layout

Monorepo. `gateway/` is the Go module `github.com/evumi/honk/gateway`; `app/` is the nsh UI, which `ios/` and `android/` host. The Go version is pinned in `mise.toml`; run Go through `mise exec -- go …` if `go` is not on PATH.

## Gateway

- `cd gateway && go test -race ./...` and `go vet ./...` before committing.
- `make run` starts it on :8080 with `./data/honk.db`; with no APNs/FCM credentials, pushes are logged and skipped.
- `cmd/honk` wires config, store, push and API. `internal/store` is SQLite through modernc (pure Go, no cgo) with one connection; the schema is `internal/store/schema.sql`, versioned with `PRAGMA user_version`. Add a new migration step for schema changes instead of editing v1 once it has shipped.
- Timestamps are Unix milliseconds; device ids are UUIDv7; message ids are SQLite integers. A bot's public id is 8 random base62 characters starting with a letter (`bots.public_id`, v2); the integer row id stays private. Never show users a sequence number as an id. A bot token is `<bot id>:<secret>`; only sha256 hashes of tokens and device secrets are stored, so pre-v2 `<integer>:<secret>` tokens still work.
- Pushes carry the banner text and `msg_id` only; devices fetch the message (card included) from the queue. Keep APNs/FCM payloads under 4 KB.
- `internal/widget` is the server-side card whitelist: static HTML/CSS (profile 1) plus inline classic `<script>`s (profile 2); `on*` handlers, `src` and module scripts are removed. It mirrors Telegram's HTML widget limits: 32 KB raw, 4 KB zlib level 9, 1 KB data.
- The bot API keeps Telegram's naming and `{"ok":…}` envelope; keep new methods consistent with it.

## iOS (ios/)

- `ios/HonkKit` is a Swift package shared by the app and the Notification Service Extension. `cd ios && make test` runs its swift-testing tests, also with only the Command Line Tools (the Makefile adds the Testing framework path). Tests use swift-testing, not XCTest, for that reason.
- The Xcode project is generated: `cd ios && make setup` fetches the nsh frameworks (`scripts/fetch-nsh-ios.sh`, sha256-checked) and runs XcodeGen on `project.yml`. Neither `Honk.xcodeproj` nor `Frameworks/` is committed. Team and gateway go in `Config/Local.xcconfig` (ignored).
- The app and the extension share the SQLite store (App Group) and credentials (keychain access group). `LocalStore.apply` must stay idempotent: the extension and a later sync both apply the same item.
- Entitlements are generated from `entitlements.properties` in `project.yml`; never leave only a `path` (XcodeGen then writes an empty dict). `make project` runs `scripts/check-entitlements.sh`.
- Simulator builds are arm64 only (nsh ships no x86_64 simulator slice): `make sim` / `make run-sim`. Debug simulator builds without an APNs token register as `simulator-<uuid>` and poll; the gateway skips pushes to such tokens.

## Android (android/)

- Gradle, minSdk 26, GMS devices only (FCM data messages; no vendor push). `:core` is plain Kotlin/JVM and mirrors `ios/HonkKit`: `ApiClient`, `LocalStore` (over the `Sql` interface; `AndroidSql` in the app, JDBC in tests), `SyncEngine`, `DeviceRegistrar`. Keep `LocalStore`'s tables and `apply()` semantics in step with `LocalStore.swift`.
- `cd android && ./gradlew :core:test` needs only a JDK 17. The app needs the Android SDK (platform 35) and the nsh AARs: `scripts/fetch-nsh-android.sh` (sha256-checked) puts them in `app/libs` (ignored); `debug` links `nsh-dev.aar`, `release` `nsh.aar`. The build runs `scripts/build-nsh-bundle.sh` and ships `app/dist/nsh` as `assets/nsh`.
- Firebase config is `android/app/google-services.json` (ignored); without it the app builds but gets no FCM token. The gateway URL is `-Phonk.gatewayUrl=…`, `HONK_GATEWAY_URL` or `honk.gatewayUrl` in `android/local.properties` (default `http://10.0.2.2:8080/`, the emulator's host). Release builds read `HONK_VERSION_NAME`/`HONK_VERSION_CODE` and the signing key from `HONK_KEYSTORE_FILE`, `HONK_KEYSTORE_PASSWORD`, `HONK_KEY_ALIAS`, `HONK_KEY_PASSWORD`, falling back to the debug key.
- nsh's `NshView` API: read the AAR's classes (`javap`) and https://nsh.dev/docs/android rather than guessing. Host replies go through org.json, which drops `null` map values: use `JSONObject.NULL`.
- A notification's tag is `c<bot>:<collapse id>` or `m<message id>`; LocalStore keeps it as the message's `notif_id`. One NotificationChannel per bot (`bot-<id>`).

## nsh app (app/)

- `cd app && nsh check App.tsx && nsh test`. With no host (`nsh run App.tsx` on a desktop) the app uses `src/demo.ts`.
- The host contract is `app/src/host.ts` on one side and `ios/App/NshBridge.swift` and `android/app/src/main/kotlin/dev/evumi/honk/NshBridge.kt` on the other; change all three together.
- Read the generated declarations in `app/.nsh/types` (created by `nsh init`/`nsh check`) for the nsh API; `calc(env(...))` is not valid for `top`/`bottom`, use `safeArea()`.
- `app/src/widget` renders cards. Scripts (profile 2) run in `sandbox.ts` on `interp.ts`, an interpreter for a JavaScript subset (`script.ts` parses it), never in the app's own context: card values are `Obj`s with no path to host objects, and every task has a time and allocation budget. `<style>` rules are applied by `css.ts` (cascade, `@media (prefers-color-scheme)`, custom properties, 400 rules) with selectors from `selector.ts`, shared with the scripts' `querySelector`. Keep the whitelist (`sanitize.ts`) and limits in step with `gateway/internal/widget`.
- UI strings are written in Chinese and wrapped in `tr("…")` (`app/src/i18n.ts`); add the English to its `EN` table in the same change. The language follows `locale()`: Chinese for `zh*`, English otherwise. Tests pin `locale: "zh-Hans-CN"`.
- Pages hide the system header (`NavPage headerVisible={false}`) and draw their own: `TopBar` (floating glass back button, title pill, avatar or text action, over a blurred top edge) and `FormBody` (scrolling content, a footer button pinned above the home indicator and the keyboard) in `app/src/components.tsx`. Floating controls use `glass(p)`; icons are `Icon` with `UI_ICONS` (24-unit stroke paths), never text glyphs. The design canvas is the reference for layout.
- App Store images: `public/appstore/README.md` (regenerate with `scripts/brand/`).

Docs come in pairs: update README.md and README.zh-CN.md together. The design document is docs/DESIGN.zh-CN.md; keep it in step with the code.
