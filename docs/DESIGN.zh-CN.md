# Honk 开发设计文档

> 本文是仓库里的权威版本，描述的是已实现的结构。最初的方案讨论见 Claude 文档「Bot 通知平台技术方案」，界面稿见 [docs/design](design/)。

Honk 是一个以 bot 为渠道的推送通知服务：每个 bot 是一个独立的通知渠道，消息可以附带一张小型 HTML 卡片，格式参照 Telegram Bot API 10.4 的 HTML widget。iOS 走 APNs，Android 走 FCM（只支持有 GMS 的设备）。

## 1. 目标与范围

和 Bark 相比要解决三件事：

- **通知内容不完整**：系统横幅只有纯文本，状态类通知（部署、告警）缺信息。Honk 在 App 里用卡片显示完整内容，横幅保留标题和正文。
- **没有渠道**：Bark 所有来源共用一个推送 key。Honk 每个 bot 一个 token，App 里每个 bot 一个会话。
- **离线丢消息**：Bark 服务端不存消息。Honk 网关保留一个短期队列，App 打开时补拉。

| 项目 | 第一期 | 说明 |
| --- | --- | --- |
| iOS | 做 | 直连 APNs，不经过 Firebase |
| Android | 只做 GMS 设备 | FCM data message；国内厂商推送不做 |
| 自定义铃声 | 不做 | 系统默认铃声，按 level 区分打扰程度 |
| 消息存储 | 网关短期队列 | 默认保留 7 天，ack 后 1 天删除；长期保存在设备本地 |
| 用户账号 | 不做 | 用设备身份（device_id + secret）代替 |

## 2. 仓库结构

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `gateway/` | Go + SQLite 网关 | 已实现，有测试 |
| `ios/HonkKit/` | App 和 NSE 共用的 Swift 包：网关客户端、Keychain、本地 SQLite、同步、通讯通知 | 已实现，有测试（macOS 上 `swift test`） |
| `ios/App/`、`ios/NotificationService/` | iOS 宿主和 Notification Service Extension；XcodeGen 生成工程 | 已实现；CI 的 `iosapp` job 构建模拟器版（`.github/workflows/ci.yml`），**尚未在真机上验证** |
| `app/` | nsh App（TSX）：会话列表、消息流、卡片渲染、创建和设置 bot | 已实现，有 `nsh test` 测试 |
| `android/core/` | 纯 Kotlin/JVM 模块，对应 HonkKit：网关客户端、本地 SQLite、同步、设备注册 | 已实现，有测试（只需 JDK：`./gradlew :core:test`） |
| `android/app/` | Android 宿主：嵌入 nsh App、FirebaseMessagingService、通知、EncryptedSharedPreferences | 已实现；CI 的 `android` job 用 Android SDK 构建 debug 版，**尚未在真机上验证** |

## 3. 消息流

```
发送方 ──/bot<token>/sendMessage──▶ 网关
                                    │ 1. 写入 messages 队列
                                    │ 2. 推送：只带横幅文字 + msg_id
                     ┌──────────────┴──────────────┐
                   APNs                           FCM
                     │ mutable-content=1            │ data message
             iOS NSE（HonkKit）              Android FCM Service
                     │ 3. GET /v1/messages/:id 拉完整消息（含卡片）
                     │ 4. 写入本地 SQLite（App Group）
                     │ 5. 横幅换成 bot 头像（通讯通知）
                     ▼
               nsh App 显示会话和卡片
                     │ 6. 打开时 GET /v1/sync 补齐，POST /v1/ack 确认
```

为什么推送里不带卡片：卡片压缩后最多 4KB，和 APNs、FCM 的 payload 上限一样大，但 base64 会多出约 33%，再加上标题正文就超了。所以推送只负责唤醒和横幅，内容由设备来拉。

修改（`editMessageData`）和删除（`deleteMessage`）走静默推送：iOS 是 `content-available` 后台推送，Android 是 NORMAL 优先级的 data message。系统不保证静默推送一定送达，所以 App 打开时的 `/sync` 是兜底。

**后台刷新**：App 不在前台时也会同步，作为推送丢失的第二道兜底。iOS：`BGAppRefreshTask`（`ios/App/BackgroundRefresh.swift`；`project.yml` 里 `UIBackgroundModes` 加了 `fetch`，`BGTaskSchedulerPermittedIdentifiers` 是 `<bundle id>.refresh`），进入后台时和每次任务运行时请求下一次（最早 6 小时后，实际时间由系统定）；Android：WorkManager 唯一周期任务 `honk-sync`（`SyncWorker`，6 小时，要求有网络，`HonkApp.onCreate` 里 KEEP 方式登记）。两端都只跑一遍和「立即同步」一样的 `refresh()`：存下队列里的消息、应用修改和删除、撤掉因此过时的通知、更新角标；都**不发本地通知**（iOS 本来就不允许；Android 的补发按 tag 去重那一步没做）。

## 4. 网关（gateway/）

### 数据表

见 `gateway/internal/store/schema.sql`。时间戳都是 Unix 毫秒。

- `devices`：`id`（UUIDv7）、`secret_hash`、`platform`（ios / android）、`push_token`、`push_ok`（APNs/FCM 报告 token 失效后置 0）
- `bots`：`id`（自增整数，只在库内使用）、`public_id`（对外的 bot id，v2 加入）、`device_id`、`token_hash`、`name`、`avatar`、`default_level`
- `messages`：队列。`kind` 是 message / edit / delete；edit 和 delete 用 `target_id` 或 `collapse_id` 指向原消息

bot id 是 8 位随机 base62 字符、以字母开头（如 `aZ3kQ9xT`），生成时查重；接口、token、推送和 App 里出现的都是它，用户看不到自增序号。messages 表的 `bot_id` 仍指向 bots 的整数主键，读出时 join 成短 id。

bot token 形如 `<bot id>:<32 位随机串>`；token 和 device secret 都只存 sha256。查 token 时按整串的哈希查，所以 v2 迁移前发出的 `<整数 id>:<secret>` 旧 token 继续有效，直到重置。

迁移：`schema.sql` 是 v1；之后的版本在 `store.go` 的 `migrate` 里按 `PRAGMA user_version` 逐步执行，每步一个事务。v2 给 bots 加 `public_id` 列、为已有 bot 补上短 id、建唯一索引。App 解码 bot id 时也接受数字（旧网关），所以要先发 App 再升级网关。`/v1/info` 的 `api` 从 1 升到 2。`/v1/bots/:id` 仍接受 v2 之前的整数 id，但只认本设备自己的 bot（按库内主键查），这样改名还在 pending 的 bot 也能删除、修改。

### 接口

所有返回都用 Telegram 的格式：`{"ok":true,"result":…}` 或 `{"ok":false,"error_code":N,"description":"…"}`。

| 接口 | 调用方 | 说明 |
| --- | --- | --- |
| `/bot<token>/sendMessage` | 发送方 | `body` 必填；`title`、`html`、`data`、`level`、`group`、`id`、`url`、`copy`、`icon` 可选；GET 查询串、表单、JSON 都行 |
| `/bot<token>/editMessageData` | 发送方 | `message_id` 或 `id` + `data`，卡片原地更新，不弹通知 |
| `/bot<token>/deleteMessage` | 发送方 | `message_id` 或 `id` |
| `/bot<token>/getMe` | 发送方 | 测试 token |
| `GET /v1/info` | App | `{name:"honk", version, api}`，切换网关前用来确认地址是 Honk 网关；`api` 2 表示 bot id 是字符串；设了 `HONK_REGISTER_KEY` 时多一个 `register_key_required: true` |
| `POST /v1/devices` | App | 注册，返回 `device_secret`（只返回这一次）；设了 `HONK_REGISTER_KEY` 时必须带相同的 `register_key`，否则 401 |
| `GET` / `PUT` / `DELETE /v1/devices/me` | App | 读取；更新 push token；删除设备及全部数据 |
| `GET` / `POST /v1/bots`，`GET` / `PATCH` / `DELETE /v1/bots/:id`，`POST /v1/bots/:id/token` | App | bot 管理；token 只在创建和重置时返回 |
| `GET /v1/messages/:id` | NSE / FCM Service | 拉一条 |
| `GET /v1/sync?cursor=&limit=`、`POST /v1/ack` | App | 补拉和确认 |

### 校验与限制

- **卡片**（`internal/widget`）：原文 ≤ 32KB，zlib 9 压缩后 ≤ 4KB，`data` ≤ 1KB，脚本也算在里面。按白名单清理：保留内联的普通 `<script>`（profile 2，见第 6 节「卡片脚本」）；删掉其他脚本、`on*` 属性、表单控件、外部资源；链接只允许 `https://`、`#id`、`{{key}}`；CSS 里禁止 `@import`、`expression()`、非 data: 的 `url()` 和反斜杠转义。
- **字段长度**：`title` ≤ 256 字，`body` ≤ 4096 字，`id` ≤ 128 字节，`icon` 必须是 https。
- **限流**：每个 bot 每秒 5 条，突发 20 条（可配）。
- **模拟器身份**：push token 以 `simulator-` 开头的设备照常注册和排队，但不发推送（见第 5 节「模拟器开发」）。
- **清理**：每小时删除过期和 ack 超过 1 天的消息。
- **注册口令**：`HONK_REGISTER_KEY` 不为空时，`POST /v1/devices` 必须带相同的 `register_key`（常量时间比较，先过 IP 限流）。App 的网关页有可选的「注册口令」输入框；iOS 存在 Keychain（`RegisterKeyStore`），Android 存在加密的 SharedPreferences，注册时作为 `register_key` 发出。只改口令（网关地址不变）不清本机数据，设备还没注册就立刻重试注册。

### 推送队列与重试

`Server.notify`（`internal/api/pushq.go`）不再每条推送开一个 goroutine，而是把推送放进有界队列，由固定数量的 worker 发送：`HONK_PUSH_QUEUE`（默认 1024，满了就丢弃并计数，日志里有记录）和 `HONK_PUSH_WORKERS`（默认 16）。

- 时机：立即、2 秒后、10 秒后、60 秒后，共 4 次（`Options.PushBackoff`）。
- 重试的失败：网络错误、超时、5xx、429；服务给了 `retry_after`（FCM 的 `Retry-After` 头）就取较大的等待，上限 2 分钟。APNs 和 FCM 把这些失败包成 `push.RetryableError{After}`，`push.Retryable(err)` 判断。token 失效（`ErrTokenGone`，照旧 `MarkPushGone`）和其他 4xx 不重试。
- 重试前检查（`store.PushStillWanted`）：设备已不存在、push token 换了或已失效、这条消息已被设备 ack（或已过期被清理），就放弃。
- 状态只在内存里。`Server.Wait()` 等排队和正在发的这一轮发完（测试用）；`Server.Close()` 是关闭路径：停止接收、丢弃还在等退避的重试、等当前这一轮发完。

### 运维

- `HONK_METRICS_ADDR`（默认空，不开）：在单独的监听地址提供 `/metrics`，Prometheus 文本格式，手写（`internal/metrics`），没有新依赖。计数：`honk_messages_total{kind}`、`honk_pushes_total{platform,route,result}`、`honk_push_retries_total`、`honk_push_dropped_total{reason}`（`queue_full`、`not_wanted`、`shutdown`）、`honk_http_requests_total{class}`；量表：`honk_devices`、`honk_bots`、`honk_push_queue_length`。`route` 现在只有 `direct`。
- `HONK_LOG_FORMAT=json` 输出 JSON 日志；`HONK_LOG_LEVEL=debug` 时每个请求记一条访问日志（`/bot<token>/…` 里的 token 替换成 `<token>`）。

## 5. 原生宿主

### iOS（ios/）

工程由 XcodeGen 从 `project.yml` 生成，有两个 target：

- `Honk`：App，界面全部由 nsh 渲染（`NativeShell.xcframework`）
- `NotificationService`：NSE

两者都依赖本地 Swift 包 `HonkKit`。

#### HonkKit

| 文件 | 作用 |
| --- | --- |
| `APIClient.swift` | `/v1` 接口客户端 |
| `Credentials.swift` | 设备凭据和各 bot token 存 Keychain，用共享 access group，`AfterFirstUnlock`，NSE 在锁屏时也能读 |
| `LocalStore.swift` | App Group 里的 SQLite，WAL + busy timeout，App 和 NSE 两个进程共用。`apply()` 处理 message / edit / delete，重复调用安全，返回需要撤掉的系统通知 id。bot id 是 TEXT；v2 迁移把 v1 的整数 bot id 转成文本，`renameBot` 再把它们换成短 id，并在 `meta` 里记下旧 id → 新 id（`currentBotID`）。改名规则在 `LegacyBotIDs.swift`，App 和 NSE 共用 |
| `Honk.swift` | `HonkConfig`（从 Info.plist 读网关地址、App Group、Keychain 组）；`ChangeSignal`（Darwin 通知，NSE 写库后通知 App 刷新）；`SyncEngine`（分页拉取、应用、ack） |
| `Avatar.swift` | 头像格式 `preset:<icon>:<#rrggbb>`、https URL 或 `local:<文件名>`；https 图片缓存到 App Group。`LocalAvatars`：用户从相册选的头像只存在本机 App Group 的 `Library/Avatars`（NSE 也能读），网关的 `avatar` 字段只存 `local:<文件名>` 这个字符串；只收 JPEG / PNG / WebP / GIF（按文件头判断），≤ 1MB；刷新时删掉没有 bot 在用、且超过 1 小时的文件。预设图标里已去掉船，旧的 `preset:ship:<颜色>` 显示为同色的铃铛 |
| `CommunicationNotification.swift` | iOS 15 通讯通知：`INSendMessageIntent` + bot 头像 |

#### NSE 流程

1. 从 `userInfo` 读 `msg_id`、`bot_id`
2. 读 Keychain 凭据，调 `GET /v1/messages/:id`
3. `LocalStore.apply(..., notificationID: request.identifier)` 记下这条消息对应哪个系统通知，之后删除或被替换时用来撤回
4. 设置角标（本地未读数，静音的 bot 不算）；静音的 bot 改成 passive、无声；`threadIdentifier` 设成 `bot-<id>`，消息有 `group` 时是 `bot-<id>:<group>`（`group` 取自拉到的消息，没拉到就从推送自带的 `thread-id`（`b<bot>:<group>`）里解析，见 `NotificationThread`）
5. 渲染头像（预设图标用 SF Symbol 画在色块上；https 头像先下载，5 秒超时；`local:` 头像读本机文件），转成通讯通知
6. `ChangeSignal.post()` 通知 App

任何一步失败，都照常显示推送自带的横幅。

#### App

- `AppDelegate`：申请通知权限，注册推送；收到静默推送就拉取并应用修改或删除；正在看的会话来消息时不弹横幅；点击通知时进入对应会话（消息的 `url` 在会话里点消息打开）。App 调用 `honk.incoming.listen` 之后，App 在前台时（不在该会话里）不弹系统横幅（通知仍安静地进通知中心），改发 `honk.incoming { botId, messageId }`，由 App 自己显示站内横幅（`app/src/InAppBanner.tsx`，设计稿 `docs/design/InApp.dc.html`）：4 秒后收起（时效性 8 秒、左侧橙色细边），点按进入会话，上滑关掉；同一个 Bot 连续来消息合并计数，静音的 Bot 不弹。
- `HonkService`：注册或更新 push token（网关返回 401 时自动重新注册）、刷新 bot 列表、同步、角标、切换网关。
  - 注册状态有四种：等待推送 token、注册中、已注册、失败（带原因）。设置页显示状态，失败时可以重试；重试会先检查已有设备，再用上次的 token 注册，都没有就重新向 APNs 要 token。
  - 切换网关：先请求 `/v1/info` 确认是 Honk 网关，地址存进 App Group（NSE 也读这里），然后清空本机的 bot、消息、token，在新网关上重新注册。旧网关上的 bot 不受影响。
- `RootViewController`：全屏 `NshAppView`。加载 `nsh/bundle.nshc`，按 `capabilities.json` 授权；设置了环境变量 `NSH_DEV_URL` 时改连 `nsh dev` 做热更新。
- `NshBridge`：nsh App 调用的 `honk.*` 宿主函数，见第 6 节。

#### 模拟器开发

- **架构**：nsh 的 xcframework 只有 arm64 模拟器切片，所以模拟器构建只支持 Apple 芯片的 Mac。`Base.xcconfig` 对模拟器排除了 x86_64，`generic/platform=iOS Simulator` 也能构建。
- **构建入口**：`make sim` 构建，`make run-sim` 构建、启动模拟器、安装并打开；`SIM="iPhone 17 Pro"` 指定机型。没在 `Local.xcconfig` 配团队时用 ad hoc 签名，entitlements 照常嵌入。
- **模拟器身份（只在 Debug + 模拟器下生效）**：拿不到 APNs token（未签名构建、APNs 报错，或 8 秒没回应）时，用固定的 `simulator-<uuid>` 身份注册。网关不给这类 token 发推送，App 在前台时每 10 秒同步一次，所以可以连真实网关完成注册、建 bot、发消息、同步。Release 构建和真机不会走这条路径。
- **Keychain 回退**：未签名或 ad hoc 构建没有共享 Keychain 组的权限，凭据会退回存到 App 自己的 Keychain。这种情况下 NSE 读不到凭据，横幅只显示推送自带的文字。

#### 配置

- `Config/Base.xcconfig`：bundle ID、App Group、Keychain 组、网关地址
- `Config/Local.xcconfig`（不入库）：自己的 `DEVELOPMENT_TEAM` 和网关地址
- Capabilities：Push Notifications、App Groups、Keychain Sharing、Communication Notifications、Time Sensitive Notifications。
  - 这些权限写在 `project.yml` 的 `entitlements.properties` 里，由 XcodeGen 生成。只写 `path` 时 XcodeGen 会把文件清成空 dict。
  - `make project` 之后会跑 `scripts/check-entitlements.sh`，缺任何一项都会失败。

### Android（android/）

Gradle 工程，minSdk 26，compileSdk / targetSdk 35。只支持有 GMS 的设备：推送全部是 FCM data message，不接国内厂商通道。两个模块：

- `:core`：纯 Kotlin/JVM，没有 Android 依赖，单元测试在 JVM 上跑（SQLite 用 sqlite-jdbc）
- `:app`：Android 宿主，依赖 `:core`

#### core（对应 HonkKit）

| 文件 | 作用 |
| --- | --- |
| `ApiClient.kt` | `/v1` 接口客户端，HttpURLConnection + kotlinx.serialization；阻塞调用，在 IO 线程用。传输层是 `Transport` 接口，测试里换成假网关 |
| `Credentials.kt` | `CredentialStore`、`BotTokenStore` 接口；`DeviceRegistrar` 注册设备或更新 push token，网关返回 401 时清掉凭据重新注册 |
| `Gateway.kt` | 网关地址规范化（规则同 `HonkConfig.normalizeGateway`）；`check()` 请求 `/v1/info` 确认是 Honk 网关；`describe()` 把错误转成中文说明 |
| `LocalStore.kt` | 表结构和 `apply()` 语义与 `LocalStore.swift` 一致：collapse 替换、edit / delete 先按 `target_id`（同一个 bot）再按 collapse id 找原消息、重复调用安全、返回要撤掉的通知。SQL 通过 `Sql` 接口执行，App 里是 `AndroidSql`，测试里是 JDBC |
| `Sync.kt` | `SyncEngine`：分页 `/v1/sync`，逐条 `apply`，先存 cursor 再 ack |
| `Models.kt`、`Avatar.kt` | 数据模型；FCM data 字段解析（`PushInfo`）；头像字符串解析 |

#### app

- `HonkService`：进程内单例，持有凭据、本地库、通知；注册、刷新（拉 bot 列表 + 同步）、处理推送、切换网关。
  - 注册状态和 iOS 一样有四种（等待推送 token、注册中、已注册、失败），`honk.status` 返回；`pushMode` 固定是 `apns`（FCM 是真实推送通道，没有模拟器模式）。重试：先用 `/v1/bots` 检查已有设备（401 就清掉凭据），再用上次的 FCM token 注册，都没有就重新向 Firebase 要 token（最多等 20 秒）。
  - 切换网关：先 `Gateway.check`，地址存进 SharedPreferences（恢复默认时删掉），然后清空本机的 bot、消息、各 bot 的 token、通知和 bot 的 channel，用当前 FCM token 在新网关上重新注册。
  - 数据库在 `noBackupFilesDir/honk.sqlite`。Android 没有单独的扩展进程，FCM Service 和界面在同一个进程里共用一个 `LocalStore`。
- `SecureStores.kt`：设备凭据和各 bot token 存 EncryptedSharedPreferences（密钥在 Android Keystore），`allowBackup=false`。
- `HonkMessagingService`（`FirebaseMessagingService`）：
  - `onNewToken`：注册或更新 token；App 每次启动也会取一次当前 token 走同样的流程（token 没变就不发请求）。刷新时网关返回 401，同样清掉凭据重新注册。
  - `onMessageReceived`：按 `gateway/internal/push/fcm.go` 的字段解析。`message`：拉 `GET /v1/messages/:id`、写库、显示通知；拉取失败就用推送里自带的标题正文显示。`edit` / `delete`：拉取后应用到本地库，按 tag 撤掉过时的通知；拉不到就整体同步。
  - `onDeletedMessages`：FCM 丢了积压的消息，整体同步。
- `Notifier`：
  - 每个 bot 一个 NotificationChannel（`bot-<id>`，放在 “Bots” 分组里），用户可以在系统设置里分别调整；删除 bot 时删掉对应的 channel。
  - MessagingStyle，发送者是代表 bot 的 `Person`，头像是 bot 头像（https 头像下载并缓存，5 秒超时、最大 2MB；`local:` 头像读 `noBackupFilesDir/avatars` 里的文件，规则同 iOS，见 `core/LocalAvatars.kt`；预设头像画成色块加 bot 名称首字）。每个 bot 推一个长期会话快捷方式，Android 11+ 会把它显示在“对话”区。
  - 通知 tag：有 collapse id 时是 `c<bot>:<collapse id>`，同 id 的新消息原地替换旧通知；否则是 `m<msg_id>`。tag 存在本地库的 `notif_id` 里，删除、替换、标记已读时据此撤掉通知。
  - `level=passive` 或 bot 静音时不响铃、不弹横幅（`setSilent`）。正在看的会话来消息时不发通知，直接标为已读。
- `MainActivity`：全屏 `NshView`，按 `assets/nsh/capabilities.json` 授权后 `loadAssetBundle("nsh")`；debug 构建可以用 intent extra `nshDevUrl` 连 `nsh dev` 热更新。Android 13+ 首次启动申请 `POST_NOTIFICATIONS`，被拒后在设置页里引导去系统设置。点击通知：发 `honk.open` 进入会话（消息的 `url` 在会话里点消息打开）。App 调用 `honk.incoming.listen` 之后，App 在前台时（不在该会话里）通知安静地进通知栏（不响铃、不弹出），并发 `honk.incoming`，由 App 显示站内横幅。
- 旧 bot id（`core/Sync.kt` 的 `LegacyBotIds`，与 HonkKit 的 `LegacyBotIDs.swift` 规则相同）：本地还有纯数字 id、而网关列表里没有它的 bot 时：
  1. 有 token 就调 `getMe` 查出短 id（旧 token 仍有效）；
  2. 没有 token，或网关答 401 / 404（token 已失效），就按 `created_at` + 名称匹配：网关列表里恰好一个本机还没有的 bot 两者都相同，本机也只有这一个旧 bot 是这个组合，才算匹配；
  3. 其他失败（离线、超时、5xx）又没匹配上的，记为 pending：`replaceBots(keeping:)` 保留它和它的消息，下次刷新再试。真正匹配不上的才删除。
  - 匹配上后 `renameBot` 迁移消息和静音 / 置顶，token 改存到新 id 下，`meta` 记下旧 id → 新 id。点开改名前的通知或快捷方式（Android 旧 intent 里是 Long，iOS 是数字 `bot_id`）时用 `currentBotId` 换成新 id。
  - 已显示的旧通知两个平台都不动：`notif_id` 里存的 tag / request id 仍能撤掉它们；同一 collapse id 的新消息到达时，旧通知按 stale 撤掉。
  - 网关列表里的短 id 已经存进本机（上次刷新时旧 bot 还在 pending）时，`renameBot` 把两行合并：消息移过去，静音 / 置顶取两者之一为真；token 只在短 id 下还没有时才搬过去。
  - `getMe` 有答复就以它为准，不再按名称和创建时间匹配。
  - 刷新时调用；推送到达时只要本机还有旧 id，就先拉 bot 列表改名，再像刷新一样应用列表（匹配不上的旧 bot 删掉，之后的推送不再请求），这样静音、名称、头像都对。iOS 在 NSE 和后台推送里，Android 在 `handlePush` 里；这一步用 5 秒超时的客户端，避免拖慢通知。
  - Android 改名时 `Notifier.moveChannel` 用旧 `bot-<整数>` channel 的重要性、声音、振动、指示灯、锁屏可见性和角标设置建 `bot-<短 id>`，再删掉旧的。
- `NshBridge`：`honk.*` 宿主函数和事件，行为对照 iOS 的 `NshBridge.swift`，见第 6 节。处理函数在 UI 线程被调用，实际工作放到 IO 线程，再通过 `NshHostReply` 回复。

#### 配置

- `android/app/google-services.json`（不入库）：Firebase 项目配置。没有它也能编译运行，只是拿不到 FCM token。
- 网关地址：`-Phonk.gatewayUrl=…`、环境变量 `HONK_GATEWAY_URL` 或 `android/local.properties` 里的 `honk.gatewayUrl`，写进 `BuildConfig.GATEWAY_URL`；默认 `http://10.0.2.2:8080/`（模拟器访问开发机）。debug 构建允许明文 http；release 只在构建时的网关地址是 http 时允许，所以 https 的 release 构建里不能切到 http 网关（检查网关时会报连不上）。
- 版本：环境变量 `HONK_VERSION_NAME` / `HONK_VERSION_CODE`，默认 `0.1.0` / `1`。
- release 签名：环境变量 `HONK_KEYSTORE_FILE`（keystore 绝对路径）、`HONK_KEYSTORE_PASSWORD`、`HONK_KEY_ALIAS`、`HONK_KEY_PASSWORD`；没设时用 debug 签名，本地也能 `./gradlew :app:assembleRelease`。产物在 `android/app/build/outputs/apk/release/`。
- 图标：自适应图标 `mipmap-anydpi-v26/ic_launcher`（另有 `ic_launcher_round`），背景色 `#1c1c1e`，前景和 Android 13 主题图标用的 monochrome 层都是按 `brand/honk-icon.svg` 写的 vector drawable，100 单位网格对应 66 dp 安全区，渲染结果和 `brand/android/ic_launcher_foreground.png` 逐像素一致。角标外圈是透明缺口，不是背景色描边，所以 monochrome 层也能显示。minSdk 是 26，所有设备都用自适应图标，所以没有旧版 mipmap PNG。状态栏小图标 `ic_notification` 用同一个字形。
- nsh：`scripts/fetch-nsh-android.sh` 下载 v0.5.1 的 `nsh-embed-android.zip` 并校验 sha256，`nsh.aar`（release）和 `nsh-dev.aar`（debug）放到 `android/app/libs/`（不入库）。构建前自动运行 `scripts/build-nsh-bundle.sh`，`app/dist/nsh` 打进 `assets/nsh`。

## 6. nsh App（app/）与宿主协议

App 用 TSX 写，跑在 QuickJS 上。页面：

- 会话列表（`Home`，带底部标签栏）
- 会话详情（`Chat`）
- 新建 Bot（`NewBot`）
- 创建成功（`BotCreated`）
- Bot 设置（`BotSettings`）

没有宿主时（例如在桌面上 `nsh run`）自动使用 `src/demo.ts` 的内存数据，方便单独调界面。

宿主协议定义在 `app/src/host.ts`、`ios/App/NshBridge.swift` 和 `android/app/src/main/kotlin/dev/evumi/honk/NshBridge.kt`，三处要同步修改。

**契约文件** `app/src/host.contract.json` 给每个 `honk.*` 调用和事件列出样例参数与返回值（`optional` 是可缺省的键，`demo: false` 是演示后端不实现的调用）。三端测试都读它：`app/src/host.contract.test.ts` 检查 `host.ts` 发出的调用名和参数形状、`demo.ts` 的返回形状；HonkKit 的 `HostContractTests` 和 `:core` 的 `HostContractTest` 检查原生侧。为此参数解码和结果、事件编码从 NshBridge 下沉到 HonkKit（`HostContract.swift`：`CallArgs`、`HostArgs`、`HostJSON`）和 `:core`（`HostContract.kt`：`Args`、`HostArgs`、`HostJson`），桥只剩平台胶水（把调用接到 `HonkService` 上）；Android 的桥在回答前把 Map 里的 null 换成 `JSONObject.NULL`（org.json 会丢掉 null 值）。已覆盖：每个调用的样例参数都能被解码、缺必填参数会报错；bot、message、chat、status、gateway 和 bot 创建的结果、全部四个事件，编码后与样例逐字段相同。没覆盖：真正的 nsh 传输、`HonkService` 里的业务逻辑、卡片调用的返回内容（只是字符串）。改协议时先改契约文件，再改 `host.ts`、`demo.ts`、两个 HonkKit / `:core` 文件和两个桥。`botId` 和 `Bot.id` 都是字符串（短 id），消息 id 是数字。

| 调用 | 参数 | 返回 |
| --- | --- | --- |
| `honk.status` | | `{registered, registration, registrationError?, pushMode, gatewayURL, notifications, appVersion, appBuild}`（设置页底部显示版本号） |
| `honk.chats` | | `Chat[]`：`{bot, muted, pinned, unread, last}` |
| `honk.messages` | `{botId, before?, limit?}` | `Message[]`，新的在前 |
| `honk.markRead` / `honk.focus` | `{botId}` | |
| `honk.refresh` | | 拉 bot 列表并同步 |
| `honk.bot.create` | `{name, avatar, defaultLevel}` | `{bot, token}` |
| `honk.bot.update` | `{botId, name?, avatar?, defaultLevel?}` | `Bot` |
| `honk.bot.token` / `honk.bot.resetToken` / `honk.bot.delete` | `{botId}` | |
| `honk.bot.setMuted` / `honk.bot.setPinned` | `{botId, muted / pinned}` | |
| `honk.message.delete` | `{messageId}` | 只删本机 |
| `honk.chat.clear` | `{botId}` | 只删本机 |
| `honk.device.delete` | | 先请求网关 `DELETE /v1/devices/me`（401 视为网关已忘记这台设备），成功后清空本机：本地库、凭据、bot token、`local:` 头像、已显示的通知（Android 还有 channel 和快捷方式），复用切换网关时的清空逻辑。网关失败就整个调用失败，本机不动。之后不立即重新注册：下次创建 bot（`honk.bot.create` 发现未注册会先注册）或重新打开 App（推送 token 到达时）才注册；这期间 `honk.status` 的 `registration` 是 `notRegistered` |
| `honk.notifications.open` | | 打开系统的通知设置 |
| `honk.register.retry` | | 重试注册，返回新的 status |
| `honk.gateway.get` | | `{url, defaultURL, custom, registerKey}`（`registerKey` 是已保存的注册口令，没有就是空串） |
| `honk.gateway.test` | `{url}` | `{ok, url?, version?, registerKeyRequired?, error?}` |
| `honk.gateway.set` | `{url, registerKey?}`（`url` 为 `null` 表示恢复默认；`registerKey` 没有或为空表示不用口令） | 切换网关，清空本机数据并重新注册；地址不变时只更新口令 |
| `honk.avatar.save` | `{data, type}`（base64 的 JPEG / PNG / WebP / GIF） | 存到本机，返回头像字符串 `local:<文件名>` |
| `honk.avatar.image` | `{avatar}` | `local:` 头像的 `data:` URL；文件不在本机时是 `null` |

新建 / 编辑 Bot 的图标列表最后是一个“+”：用 nsh 的 `Picker.pickImages`（`picker` 权限，缩到 512px）选一张图，经 `honk.avatar.save` 存在本机，头像字符串作为 `avatar` 发给网关。图片本身不上传，所以换手机、重装或切换网关后会变回默认头像。nsh 端用 `data:` URL 显示本机头像，加载失败时退回预设图标。

宿主发给 App 的事件有这些（样例在契约文件里）：

- `honk.changed`：本地库有变化，App 重新加载
- `honk.open {botId}`：用户点了通知，打开对应会话
- `honk.incoming {botId, messageId}`：App 打开时来了消息，由 App 自己显示横幅
- `honk.card.changed {key, result}`：卡片脚本的定时器改变了画面

静音和置顶只存在本地，不上传网关。

### 卡片渲染（profile v1）

代码在 `app/src/widget/`。

1. `parse.ts`：容错的 HTML 子集解析器；`fill()` 用 `data` 填 `{{key}}` 占位符，style 属性里的占位符也会填
2. `Widget.tsx`：
   - 块级元素渲染成 `View`，连续的行内内容合并成一个带嵌套 span 的 `Text`
   - flex 容器的子元素按 flex item 处理，`inline-flex` / `inline-block` 宽度跟随内容，带尺寸或背景的行内元素渲染成盒子
   - CSS 子集映射到 nsh 样式：布局、间距、边框、圆角、颜色、字体、阴影、渐变
   - 样式来自 `<style>` 和 `style` 属性，见下面「样式表」
   - 带 `hidden` 属性的元素不渲染
   - `var(--tg-theme-*)` 从当前主题取色，深色模式自动切换
   - `https://` 链接和 `button[data-url]` 点击后用系统打开
   - 超过 2000 个节点时不渲染卡片，只显示正文
   - 内联 `<svg>`：`svg.ts` 把已经过白名单的子树重新序列化成 SVG 标记（只写 SVG 元素和白名单属性，`use` 只能引用 `#id`，`url()` 只能是 `url(#id)`，带反斜杠的值（CSS 转义）丢掉，属性值和文本都转义；网关对 SVG 元素的属性用同样的规则；属性名按 SVG 恢复大小写，如 `viewBox`、`linearGradient`），先替换 `{{key}}`、`var()`、`currentColor`，再作为 `data:image/svg+xml` 交给 nsh 的 `Image` 栅格化。宽高取 CSS，其次 `width`/`height` 属性（`100%` 为容器宽度），再次 `viewBox` 比例；`preserveAspectRatio="none"` 对应 `objectFit: "fill"`，`slice` 对应 `cover`，其余 `contain`。行内文字里的 `<svg>` 不画。演示数据里“Evumi 报告”的卡片是一张内联 SVG 折线图
3. 带脚本的卡片（profile 2）见下面「卡片脚本」。

### 样式表

Telegram 的 widget 一般用 class 加 `<style>` 写，所以 Honk 也按样式表渲染，而不只是内联 `style`：

- `selector.ts`：选择器解析和匹配。支持标签、`*`、`#id`、`.class`、属性选择器（`=`、`~=`、`^=`、`$=`、`*=`、`|=`），后代、`>`、`+`、`~` 组合符，`:first-child`、`:last-child`、`:only-child`、`:nth-child(odd | even | an+b)`、`:root`。卡片没有 `<html>` 和 `<body>`，`html`、`body` 都指卡片的根（`:root`），但优先级按标签算。`:hover`、伪元素等不支持的选择器，所在规则整条忽略
- `css.ts`：把所有 `<style>` 的文本（静态卡片先填 `{{key}}`）解析成规则，按最右边一段的 id / class / 标签建索引。`@media` 只认 `prefers-color-scheme`（加上 `screen`、`all`），跟随 App 的深浅色；其他媒体查询、`@keyframes`、`@font-face`、`@supports`、嵌套规则都跳过。最多 400 条规则（Telegram 的上限），后面的不生效。和网关一样，能加载资源的声明（`url()`、`image-set()` 等）会被丢掉
- 层叠：普通声明按优先级、再按先后；然后是内联 `style`；最后是规则里的 `!important`
- 变量：`--x` 按继承传给子元素，`var()` 先在元素自己和祖先上找，再找主题变量；`:root` 上不能覆盖 `--tg-*`（Telegram 也是这样）。`light-dark(a, b)` 按当前深浅色取值。`:root` 的其他声明作用于整张卡片（文字样式和外框）
- `display: none` 的元素（块级和行内）不渲染
- 静态卡片在读取调色板的表达式里渲染，切换深浅色时整张重画

网关早就保留 `<style>`（有危险写法时整块删掉），这次没有改规则，只加了测试，确认 class、id、媒体查询、变量和 `{{key}}` 原样保留。

演示数据（`src/demo.ts`）里“CI 构建”的最新一条是用 class 和 `<style>` 写的卡片：`{{status}}` 写在 class 里，失败时才显示失败的测试，深色模式换一组颜色。

### 卡片脚本（profile 2）

#### Telegram 的做法（Bot API 10.4，2026-11-09）

依据 https://core.telegram.org/bots/widgets 和 Bot API 10.4 的更新日志整理：

- **格式**：一个自包含的 HTML 文档，内联 CSS 和 JavaScript；HTML ≤ 32768 字节，zlib 9 压缩后 ≤ 4096 字节。图片只能是 data: URL 或内联 SVG，外部脚本、样式、字体、图片都不加载。消息里没有声明“是否带脚本”的字段；`TelegramWidget.profile` 是 Telegram 自己的接口级别（现在是 1），`isProfileAtLeast(n)` 用来做特性检测，客户端不支持的特性会被去掉，其余照常运行。
- **运行环境**：JS 跑在 QuickJS（ES2023）里，“不在 WebView 或浏览器里”，DOM 是 Telegram 自己实现的。`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`RTCPeerConnection`、`sendBeacon`、`importScripts`、`Worker`、`BroadcastChannel` 抛 `NetworkDisabledError`；没有 `location`、`history`，`alert` 不显示，`confirm` 返回 false，`prompt` 返回 null；没有剪贴板、分享、震动、定位、媒体、通知、Shadow DOM、自定义元素、Blob、WebGL。`eval` 和 `new Function` 可以用（在沙箱内）。`localStorage` / `sessionStorage` 每条消息各 4KB，不上传给 bot。
- **接口 `window.TelegramWidget`**（在 Telegram 之外是 undefined）：
  - 属性：`profile`、`colorScheme`、`themeParams`（冻结对象，键名同 Mini Apps：`bg_color`、`text_color`、`hint_color`、`link_color`、`button_color`、`button_text_color`、`secondary_bg_color`、`accent_text_color` 等）、`isActive`、`isPreview`、`isForward`、`chatType`、`viewer`、`publicData` / `chatData`（≤ 1024 字节的字符串或 null，只读）、`wallet`、`contentSafeAreaInset`、`HapticFeedback`
  - 方法：`isProfileAtLeast`、`request(data)`（1–64 字节，返回 Promise，bot 用 `answerWidgetQuery` 在 15 秒内回答）、`copyText`、`openLink`（https、≤ 256 字符，需要用户确认）、`openTelegramLink`、`watchPublicData` / `unwatchPublicData`、`setResizeAnchor`、`ready`、`onEvent` / `offEvent`
  - 事件：`themeChanged`、`activated`、`deactivated`、`chatDataChanged`、`publicDataChanged`、`contentSafeAreaChanged`；处理函数的 `this` 是 `TelegramWidget`，没有参数，每种最多 16 个
  - 链接、复制、`request` 只能在一次真实点击的处理函数里同步调用，每次点击一次
  - CSS 变量写在根元素上：`--tg-theme-*`、`--tg-color-scheme`、`--tg-text-*`、`--tg-button-*`、安全区变量；`prefers-color-scheme` 跟随聊天主题
- **输入**：click、pointer 事件、dblclick、contextmenu；没有键盘、文本输入、触摸事件和滚轮
- **限制**：JS 每秒最多 300ms，单个任务 500ms 就停掉 widget；内存 8MB；节点 2000；每个任务 DOM 修改 10000 次、布局读取 128 次；定时器 64 个；动画 64 个；CSS 400 条规则；连续崩溃 2 次后停止到下次启动。离开屏幕时暂停（`deactivated`），隐藏时定时器每秒最多触发一次，widget 随时可能被销毁重建
- **bot 端**：`sendWidget`（`html`、`caption`、`width` / `height`、`chat_data`、`public_data`、`allow_queries`、`is_shared`）、`editMessageWidgetData`、`editSharedWidgetData`、`answerWidgetQuery`，更新类型 `widget_query` / `shared_widget_query`
- **降级**：不支持 widget 的客户端把消息显示成“不支持的媒体”加 caption，所以一定要带 caption

#### Honk 的实现

每张卡片一个独立的 QuickJS 运行时（[quickjs-ng](https://github.com/quickjs-ng/quickjs) v0.18.0，MIT），由 iOS / Android 宿主在后台线程上运行。nsh 只给 App 一个 QuickJS 上下文、不能另开，App 自己的 Rust crate 也进不了预编译的嵌入框架，所以引擎放在宿主里；两端共用同一份 C 代码。

| 位置 | 作用 |
| --- | --- |
| `native/quickjs/` | quickjs-ng 的引擎核心（只有 `quickjs.c`、`libregexp.c`、`libunicode.c`、`dtoa.c` 和头文件），不带 `quickjs-libc`，所以卡片没有文件、网络、进程和 `std` / `os` 模块。版本见 `VERSION` |
| `native/card/honk_card.c` | 沙箱（`honk_card_answer` 把宿主取回的答案交给卡片，答案 ≤ 1024 字节且须是 UTF-8）：每张卡片一个 `JSRuntime`，自己的分配器计内存（超过 8MB 拒绝分配并中断，脚本抓不到），中断回调按截止时间停任务，栈上限 256KB；每秒脚本时间超过 300ms 时，下一次 tick 推到下一秒。读脚本返回的东西时只读自有数据属性和自己解析的 JSON，不会触发卡片的 getter；链接只放行 https、≤ 256 字符、每次点击一次，复制 1–256 字符、每次点击一次；树超过 512KB 就停止卡片 |
| `native/card/runtime.js` | 卡片里的页面：精简 DOM（节点、属性、`classList`、`style`、`dataset`、`innerHTML`、选择器、事件冒泡、`onclick`）、定时器（由宿主的 tick 驱动）、4KB 的 `localStorage` / `sessionStorage`、`console`、`TelegramWidget`。`gen_runtime.py` 把它生成 `runtime_js.h` 编进 C 里 |
| `native/Package.swift`、`native/swift/HonkCard/CardHost.swift` | iOS：本地 Swift 包。`CardHost` 把所有卡片放在一个串行队列上，按 `honk_card_next` 安排 tick；最多同时保留 8 张卡片，所有卡片的堆加起来超过 32MB 时也关掉最久没用的（`honk_card_memory`） |
| `native/jni/`、`android/core/.../CardHost.kt` | Android：JNI（字符串用 UTF-8 字节数组传，JNI 自己的字符串是修改过的 UTF-8）和与 Swift 相同的 `CardHost`，在一个 4MB 栈的后台线程上；`libhonkcard.so` 由 `android/app` 的 CMake 构建 |
| `app/src/widget/Widget.tsx`、`sanitize.ts` | App：有 `<script>` 的卡片先显示静态卡片，再把填好 `{{key}}` 的节点树交给宿主；之后按宿主返回的树渲染。返回的树一律再过一遍白名单（`cleanTree`：标签、属性、链接、CSS、2000 个节点、128 层），因为卡片在自己的运行时里能改掉一切 |

宿主协议新增（`host.ts` ↔ `NshBridge.swift` ↔ `NshBridge.kt`），参数和返回都是 JSON 字符串：

| 调用 | 参数 | 返回 |
| --- | --- | --- |
| `honk.card.open` | `{key, load}`：`load` 是 `{tree, data, theme, language, active, allowQueries}` | 结果 |
| `honk.card.click` | `{key, path}`：从根开始的子节点下标，如 `[0,2]` | 结果 |
| `honk.card.set` | `{key, state}`：`{theme}` 或 `{active}` | 结果 |
| `honk.card.answer` | `{key, seq, ok, data}`：对结果里 `request` 的回答；`ok` 为真时 `data` 是 bot 的答案（≤ 1024 字节，超出或不是 UTF-8 则请求以 `BAD_ANSWER` 失败），否则 `data` 是错误码（`A–Z` 和 `_`，≤ 32 字符，如 `NETWORK`，其他值变成 `REQUEST_FAILED`） | 结果 |
| `honk.card.close` | `{key}` | `true` |
| 事件 `honk.card.changed` | `{key, result}` | 定时器或 Promise 改了卡片 |

结果是 `{tree, prevented, open?, copy?, request?, stopped, logs}`：`tree` 只在变化时给（写入相同的文字、属性或 `innerHTML` 不算变化），App 收到和屏幕上相同的树也不重画；`open` / `copy` 由 App 用已有的 `openUrl` 和剪贴板执行；`prevented` 为假时，再执行被点元素自己的链接。有点击处理函数的元素在树里带 `on: true`，App 只让这些元素可点。

`request`（`{seq, data}`，只出现在 click 的结果里）表示卡片在这次点击里调了 `TelegramWidget.request(data)`：`data` 是 1–64 字节的 UTF-8，`seq` 是卡片内递增的正整数（C 一侧像对待所有返回值一样校验）。宿主把它发给 bot，拿到答案后调 `honk.card.answer`（C：`honk_card_answer(card, seq, ok, data, len)`），卡片的 Promise 随之兑现或拒绝，返回的结果和 tick 一样（树的变化、日志，没有 `open` / `copy` / `request`）。只有 load 里带 `allowQueries: true`（消息的 `allow_queries`）时才会发出请求，否则 `request()` 以 `NOT_ALLOWED` 拒绝。`WidgetRequestError.code`：`NOT_ALLOWED`（没开 `allowQueries`、不是在点击处理函数里同步调用、同一次点击里的第二次）、`INVALID_DATA`（不是 1–64 字节的字符串）、`TOO_MANY_REQUESTS`（已有 4 个未答的）、`TIMEOUT`（15 秒没人回答，由 tick 驱动，所以宿主要照常按 `honk_card_next` 安排 tick）、宿主给的错误码（`BAD_ANSWER`、`REQUEST_FAILED` 等）。未知或已答过的 `seq` 被忽略。

限制，和 Telegram 对比：

| 项目 | Honk | Telegram |
| --- | --- | --- |
| 单个任务（加载时的每个脚本、一次 tick、一次点击） | 200ms，超时停止卡片 | 500ms |
| 每秒脚本时间 | 300ms，超出后 tick 推迟到下一秒 | 300ms |
| 内存 | 8MB（含运行时本身），超出停止卡片 | 8MB |
| 节点 | 2000 | 2000 |
| 每个任务的 DOM 修改 | 10000 | 10000 |
| 定时器 | 64；`setInterval` 最短 16ms；App 不在前台时每秒最多一次 | 64 |
| 每种事件的处理函数 | 16 | 16 |
| `localStorage` | 4KB，只在这次运行内有效 | 4KB / 条消息 |
| 同时运行的卡片 | 8 张，堆合计 32MB，超出关掉最久没用的 | |

脚本在宿主的后台线程上跑，卡死也不会卡住界面。“停止”：卡片保留最后一次画出的样子，不再响应；因为超时停止的卡片还会把最后的树交出来。没被捕获的异常只写日志（`logs`，App 打到控制台），卡片继续运行。

和 Telegram 不同的地方：`request()` 只在消息允许查询（`allow_queries`）时发出，错误码见上；只有 click 事件；`getBoundingClientRect` 返回全 0；没有 canvas；`HapticFeedback` 什么也不做；`publicData`、`viewer`、`wallet` 都是 null。`editMessageData` 改了数据时，会话里这张卡片按新数据重建，脚本重新运行；滚出屏幕再回来时也会重建。

兼容：网关保留内联的普通 `<script>`（去掉属性），删掉带 `src`、`type` 不是 JavaScript、在 SVG 里，或文本里有 `<!--`、`<script`、`</script` 的脚本（后几种在 HTML 规范和 App 的解析器里切分不同，可能把脚本后面的内容当成没清理过的标记）。旧版 App 的渲染器本来就跳过 `<script>`；没有宿主（`nsh run` 演示）或宿主调用失败时，新版 App 也显示静态卡片。所以卡片在不跑脚本时也要能看：关键信息写在 HTML 里，脚本只做增强。

测试：`make -C native test asan`（C：隔离、死循环、内存、递归、点击和链接、伪造结果、定时器和 Promise、每秒预算、节点和输出上限、语法错误、主题事件；ASan / UBSan，Linux 上查内存泄漏），`cd native && swift test`（iOS 的 `CardHost`），`./gradlew :core:test`（Android 的 `CardHost` 通过 JNI 在 JVM 上跑，库由 `make -C native jni` 在本机构建），`app/src/widget/Widget.test.tsx`（模拟宿主：渲染、白名单、点击、链接、复制、事件）。CI 另外构建 iOS 模拟器版和 Android debug 版。演示数据里“服务器告警”的最新一条是带脚本的卡片（CPU 柱状图切换 1 小时 / 24 小时、每秒更新的“持续 N 分钟”、复制 SSH 命令）；桌面上 `nsh run` 没有宿主，只显示静态部分。

## 7. 推送字段映射

| 字段 | APNs | FCM |
| --- | --- | --- |
| bot 名称 / `title` / `body` | `alert.title` / `alert.subtitle` / `alert.body`，`mutable-content: 1` | data 里的 `bot_name`、`title`、`body`，由 App 建通知 |
| `level=passive` | `interruption-level: passive`，priority 5，无声 | priority NORMAL |
| `level=active` | `interruption-level: active` | priority HIGH |
| `level=timeSensitive` | `interruption-level: time-sensitive` | priority HIGH |
| `group` | `thread-id: b<bot>:<group>`（NSE 再把它改成 `bot-<id>:<group>`） | data 里的 `group` |
| `id` | `apns-collapse-id: b<bot>:<id>`（超过 64 字节时取哈希） | `collapse_key`；data 里的 `id`，App 用它做通知 tag |
| edit / delete | `content-available: 1` 后台推送 | priority NORMAL 的 data message |

## 8. 本地开发

```bash
cd gateway && make test && make run      # 网关，:8080
cd ios && make test                      # HonkKit 测试（只有 Command Line Tools 也能跑）
cd app && nsh test && nsh run App.tsx    # nsh App 测试；在桌面上用演示数据运行
cd ios && make setup                     # 下载 nsh 框架并生成 Xcode 工程（需要 XcodeGen）
cd android && ./gradlew :core:test       # Android 核心逻辑测试（只需 JDK 17）
cd android && make setup && ./gradlew assembleDebug   # 下载 nsh AAR 并编译 App（需要 Android SDK）
```

真机联调需要：

- `Local.xcconfig` 里填好团队和网关地址
- 网关配置 APNs `.p8` key；开发版构建要设 `HONK_APNS_SANDBOX=true`

## 9. 待办与风险

- [ ] 真机跑通 APNs、NSE 和通讯通知头像（模拟器已能连真实网关完成注册、建 bot、发送和同步；CI 的 `iosapp` job 已构建模拟器版）
- [ ] 在有 GMS 的设备或模拟器上跑通 FCM、通知和 nsh 界面（CI 的 `android` job 已用 Android SDK 跑 `:core:test` 并构建 debug 版）
- [ ] 后台刷新（iOS `BGAppRefreshTask`、Android WorkManager 每 6 小时）和「删除这台设备的数据」的原生代码只在 CI 里编译，没在真机上跑过；Android 的后台同步还不补发通知
- [ ] Android 预设头像现在画的是 bot 名称首字，和 App 内的图标不一致；可以给 Android 加一套对应的矢量图标
- [x] 卡片 profile 2：JS（宿主里的 quickjs-ng）、`TelegramWidget` 兼容接口
- [ ] 卡片按钮回调：沙箱一侧已就绪（`request()`、`honk_card_answer`），网关的 `answerWidgetQuery`、webhook / 长轮询和宿主接线随同一个版本；`publicData` / 共享卡片
- [ ] 卡片脚本在真机上的耗时和内存还没测过；pointer 事件、canvas 没有
- [ ] 推送内容端到端加密（参考 Bark 的 ciphertext），消息在网关上只存密文
- **nsh 还是 0.5.x**：推送和扩展全部用原生写，nsh 只负责 App 内界面，把升级的影响面控制在 UI 层。
- **NSE 资源有限**：NSE 内存约 24MB、运行约 30 秒，所以只做拉取、写库和渲染头像，不加载 nsh。
