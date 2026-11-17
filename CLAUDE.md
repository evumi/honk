# CLAUDE.md

Guidance for Claude Code in this repository.

## Layout

Monorepo. `gateway/` is the Go module `github.com/evumi/honk/gateway`; `app/` (nsh), `ios/` and `android/` are planned. The Go version is pinned in `mise.toml`; run Go through `mise exec -- go …` if `go` is not on PATH.

## Gateway

- `cd gateway && go test -race ./...` and `go vet ./...` before committing.
- `make run` starts it on :8080 with `./data/honk.db`; with no APNs/FCM credentials, pushes are logged and skipped.
- `cmd/honk` wires config, store, push and API. `internal/store` is SQLite through modernc (pure Go, no cgo) with one connection; the schema is `internal/store/schema.sql`, versioned with `PRAGMA user_version`. Add a new migration step for schema changes instead of editing v1 once it has shipped.
- Timestamps are Unix milliseconds; device ids are UUIDv7; bot and message ids are SQLite integers. A bot token is `<bot id>:<secret>`; only sha256 hashes of tokens and device secrets are stored.
- Pushes carry the banner text and `msg_id` only; devices fetch the message (card included) from the queue. Keep APNs/FCM payloads under 4 KB.
- `internal/widget` is the server-side card whitelist (profile v1, static HTML/CSS). It mirrors Telegram's HTML widget limits: 32 KB raw, 4 KB zlib level 9, 1 KB data.
- The bot API keeps Telegram's naming and `{"ok":…}` envelope; keep new methods consistent with it.

## iOS (ios/)

- `ios/HonkKit` is a Swift package shared by the app and the Notification Service Extension. `cd ios && make test` runs its swift-testing tests, also with only the Command Line Tools (the Makefile adds the Testing framework path). Tests use swift-testing, not XCTest, for that reason.
- The Xcode project is generated: `cd ios && make setup` fetches the nsh frameworks (`scripts/fetch-nsh-ios.sh`, sha256-checked) and runs XcodeGen on `project.yml`. Neither `Honk.xcodeproj` nor `Frameworks/` is committed. Team and gateway go in `Config/Local.xcconfig` (ignored).
- The app and the extension share the SQLite store (App Group) and credentials (keychain access group). `LocalStore.apply` must stay idempotent: the extension and a later sync both apply the same item.

## nsh app (app/)

- `cd app && nsh check App.tsx && nsh test`. With no host (`nsh run App.tsx` on a desktop) the app uses `src/demo.ts`.
- The host contract is `app/src/host.ts` on one side and `ios/App/NshBridge.swift` on the other; change both together.
- Read the generated declarations in `app/.nsh/types` (created by `nsh init`/`nsh check`) for the nsh API; `calc(env(...))` is not valid for `top`/`bottom`, use `safeArea()`.
- `app/src/widget` renders cards (profile v1). Keep its limits in step with `gateway/internal/widget`.

Docs come in pairs: update README.md and README.zh-CN.md together. The design document is docs/DESIGN.zh-CN.md; keep it in step with the code.
