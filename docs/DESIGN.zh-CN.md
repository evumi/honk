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

修改（`editMessageData`）和删除（`deleteMessage`）走静默推送：iOS 是 `content-available` 后台推送，Android 是 NORMAL 优先级的 data message。`silent=true` 的新消息走同一条路径（见第 7 节）。系统不保证静默推送一定送达，所以 App 打开时的 `/sync` 是兜底。

**后台刷新**：App 不在前台时也会同步，作为推送丢失的第二道兜底。iOS：`BGAppRefreshTask`（`ios/App/BackgroundRefresh.swift`；`project.yml` 里 `UIBackgroundModes` 加了 `fetch`，`BGTaskSchedulerPermittedIdentifiers` 是 `<bundle id>.refresh`），进入后台时和每次任务运行时请求下一次（最早 6 小时后，实际时间由系统定）；Android：WorkManager 唯一周期任务 `honk-sync`（`SyncWorker`，6 小时，要求有网络，`HonkApp.onCreate` 里 KEEP 方式登记）。两端都只跑一遍和「立即同步」一样的 `refresh()`：存下队列里的消息、应用修改和删除、撤掉因此过时的通知、更新角标；都**不发本地通知**（iOS 本来就不允许；Android 的补发按 tag 去重那一步没做）。

## 4. 网关（gateway/）

### 数据表

见 `gateway/internal/store/schema.sql`。时间戳都是 Unix 毫秒。

- `devices`：`id`（UUIDv7）、`secret_hash`、`platform`（ios / android）、`push_token`、`push_ok`（APNs/FCM 报告 token 失效后置 0）；v4 加 `owner_id`、`name`（机型名）、`seen_at`（最近一次请求，最多每小时写一次）、`acked_up_to`（这台设备的 ack 水位）
- `owners`（v4）：设备组，`id`（UUIDv7，不透明）、`created_at`。bot、队列和设备都属于一个组；授权只看 `owner_id`
- `links`（v4）：配对数据，`link_hash`（`link_id` 的 sha256）、`owner_id`、`bundle`（网关不能解开）、`created_at`、`expires_at`
- `bots`：`id`（自增整数，只在库内使用）、`public_id`（对外的 bot id，v2 加入）、`device_id`（v1 的列，v4 之后只表示创建它的设备，不再用来授权）、`owner_id`（v4）、`token_hash`、`name`、`avatar`、`default_level`
- `messages`：队列（v4 起按 `owner_id` 查，`device_id` 不再写入；`acked_at` 不再用）。`kind` 是 message / edit / delete；edit 和 delete 用 `target_id` 或 `collapse_id` 指向原消息。发送选项：`open_mode`（`url` 或空）、`image`、`parse_mode`（`Markdown` 或空）、`silent`（0 / 1），v5 加入，JSON 里分别叫 `open`、`image`、`parse_mode`、`silent`，空值不输出；`expires_at` 由 `ttl` 参数决定（不填用 `HONK_MESSAGE_TTL`）
- `relays`（v3）：登记过的自建网关，`id`、`key_hash`、`created_at`、`last_used_at`（每分钟最多写一次）、`blocked`；只有开了 `HONK_RELAY_SERVE` 的网关用它
- `meta`（v3）：这个网关自己的键值设置；中继客户端把 `relay_url`、`relay_id`、`relay_key` 存在这里

bot id 是 8 位随机 base62 字符、以字母开头（如 `aZ3kQ9xT`），生成时查重；接口、token、推送和 App 里出现的都是它，用户看不到自增序号。messages 表的 `bot_id` 仍指向 bots 的整数主键，读出时 join 成短 id。

bot token 形如 `<bot id>:<32 位随机串>`；token 和 device secret 都只存 sha256。查 token 时按整串的哈希查，所以 v2 迁移前发出的 `<整数 id>:<secret>` 旧 token 继续有效，直到重置。

迁移：`schema.sql` 是 v1；之后的版本在 `store.go` 的 `migrate` 里按 `PRAGMA user_version` 逐步执行，每步一个事务。v2 给 bots 加 `public_id` 列、为已有 bot 补上短 id、建唯一索引。App 解码 bot id 时也接受数字（旧网关），所以要先发 App 再升级网关。v5（`migrateSendOptions`；v3、v4 是中继表和设备组）给 messages 加 `open_mode`、`image`、`parse_mode`、`silent`；两个 LocalStore 也各有一步 v3（`migrateSendOptions` / `MIGRATE_SEND_OPTIONS`），给本地 messages 加同名的四列，旧行取默认值，旧 App 不认识新字段，照常忽略。`/v1/info` 的 `api` 从 1 升到 2。`/v1/bots/:id` 仍接受 v2 之前的整数 id，但只认本设备自己的 bot（按库内主键查），这样改名还在 pending 的 bot 也能删除、修改。

v4 迁移：建 `owners`、`links`；给 `devices`、`bots`、`messages` 加 `owner_id`；每台现有设备各自成组（行为不变），它的 bot 和排队的消息随它；`seen_at` 用 `updated_at` 补，`acked_up_to` 由 v1 的逐条 `acked_at` 推出（第一条未 ack 的消息之前的最大 id，全部 ack 过就是最大 id）。`bots.device_id` 对 `devices` 有外键级联，SQLite 不重建表就删不掉它，重建又会级联删除消息，所以保留这一列；删除设备组里的一台设备时先把它创建的 bot 的 `device_id` 改给组里留下的设备，bot 才不会被级联删掉。

### 接口

所有返回都用 Telegram 的格式：`{"ok":true,"result":…}` 或 `{"ok":false,"error_code":N,"description":"…"}`。

| 接口 | 调用方 | 说明 |
| --- | --- | --- |
| `/bot<token>/sendMessage` | 发送方 | `body` 必填；`title`、`html`、`data`、`level`、`group`、`id`、`url`、`copy`、`icon`、`open`、`image`、`ttl`、`silent`、`parse_mode` 可选；GET 查询串、表单、JSON 都行 |
| `/bot<token>/editMessageData` | 发送方 | `message_id` 或 `id` + `data`，卡片原地更新，不弹通知 |
| `/bot<token>/deleteMessage` | 发送方 | `message_id` 或 `id` |
| `/bot<token>/getMe` | 发送方 | 测试 token |
| `GET /v1/info` | App | `{name:"honk", version, api, features, push}`，切换网关前用来确认地址是 Honk 网关；`api` 2 表示 bot id 是字符串；`features` 是能力列表（支持设备组和配对含 `"link"`，开了 `HONK_RELAY_SERVE` 含 `"relay"`，旧网关没有这个字段）；`push: {ios, android}` 是每个平台的推送方式 `direct` / `relay` / `off`（旧网关没有）；设了 `HONK_REGISTER_KEY` 时多一个 `register_key_required: true` |
| `POST /v1/relay/gateways`、`POST /v1/relay/push` | 自建网关 | 推送中继，只在 `HONK_RELAY_SERVE=true` 时存在，见下一节 |
| `POST /v1/devices` | App | 注册，返回 `device_secret`（只返回这一次）；设了 `HONK_REGISTER_KEY` 时必须带相同的 `register_key`，否则 401 |
| `GET` / `PUT` / `DELETE /v1/devices/me` | App | 读取；更新 push token 和 `name`；把这台设备从设备组移除（最后一台时连组、bot、队列一起删）；`?all=true` 删除整个设备组 |
| `GET /v1/devices`、`DELETE /v1/devices/:id` | App | 设备组里的设备（`id`、`name`、`platform`、`seen_at`、`current`）；移除组里的一台 |
| `POST /v1/links`、`POST /v1/links/claim` | App | 配对，见下面「设备组」 |
| `GET` / `POST /v1/bots`，`GET` / `PATCH` / `DELETE /v1/bots/:id`，`POST /v1/bots/:id/token` | App | bot 管理；token 只在创建和重置时返回 |
| `GET /v1/messages/:id` | NSE / FCM Service | 拉一条 |
| `GET /v1/sync?cursor=&limit=`、`POST /v1/ack` | App | 补拉和确认 |

### 校验与限制

- **卡片**（`internal/widget`）：原文 ≤ 32KB，zlib 9 压缩后 ≤ 4KB，`data` ≤ 1KB，脚本也算在里面。按白名单清理：保留内联的普通 `<script>`（profile 2，见第 6 节「卡片脚本」）；删掉其他脚本、`on*` 属性、表单控件、外部资源；链接只允许 `https://`、`#id`、`{{key}}`；CSS 里禁止 `@import`、`expression()`、非 data: 的 `url()` 和反斜杠转义。
- **字段长度**：`title` ≤ 256 字，`body` ≤ 4096 字，`id` ≤ 128 字节，`icon` 和 `image` 必须是 https。
- **发送选项**：`open` 只能是 `chat` 或 `url`，`url` 要同时给 `url`；`parse_mode` 只认 `Markdown`（不分大小写）；`silent` 是 `true` / `false` / `1` / `0`；`ttl` 是 60 到 `HONK_MESSAGE_TTL` 之间的整数秒。校验不过一律 400。Markdown 正文的横幅文字由网关去掉标记（`internal/api/markdown.go` 的 `StripMarkdown`），和 App 的渲染子集（`app/src/markup.ts`）保持一致。
- **限流**：每个 bot 每秒 5 条，突发 20 条（可配）。
- **模拟器身份**：push token 以 `simulator-` 开头的设备照常注册和排队，但不发推送（见第 5 节「模拟器开发」）。
- **清理**：每小时删除过期的消息、设备组里每台设备都已 ack 且创建超过 `HONK_ACKED_KEEP`（1 天）的消息，以及按 `HONK_DEVICE_GC` 回收的废弃设备（见下面「设备组」）。
- **注册口令**：`HONK_REGISTER_KEY` 不为空时，`POST /v1/devices` 必须带相同的 `register_key`（常量时间比较，先过 IP 限流）。App 的网关页有可选的「注册口令」输入框；iOS 存在 Keychain（`RegisterKeyStore`），Android 存在加密的 SharedPreferences，注册时作为 `register_key` 发出。只改口令（网关地址不变）不清本机数据，设备还没注册就立刻重试注册。

### 推送队列与重试

`Server.notify`（`internal/api/pushq.go`）不再每条推送开一个 goroutine，而是把推送放进有界队列，由固定数量的 worker 发送：`HONK_PUSH_QUEUE`（默认 1024，满了就丢弃并计数，日志里有记录）和 `HONK_PUSH_WORKERS`（默认 16）。

- 时机：立即、2 秒后、10 秒后、60 秒后，共 4 次（`Options.PushBackoff`）。
- 重试的失败：网络错误、超时、5xx、429；服务给了 `retry_after`（FCM 的 `Retry-After` 头）就取较大的等待，上限 2 分钟。APNs 和 FCM 把这些失败包成 `push.RetryableError{After}`，`push.Retryable(err)` 判断。token 失效（`ErrTokenGone`，照旧 `MarkPushGone`）和其他 4xx 不重试。
- 重试前检查（`store.PushStillWanted`）：设备已不存在、push token 换了或已失效、这条消息已被**这台设备**的水位覆盖（`id <= devices.acked_up_to`），或已不在设备组的队列里（过期、被清理），就放弃。设备组里别的设备是否 ack 不影响这台的重试。
- 扇出：`notifyOwner` 对设备组里每台 `push_ok` 且有 token 的设备各发一次（消息、修改、删除都一样），每台各自重试。
- 状态只在内存里。`Server.Wait()` 等排队和正在发的这一轮发完（测试用）；`Server.Close()` 是关闭路径：停止接收、丢弃还在等退避的重试、等当前这一轮发完。

### 设备组（多设备与换机）

**模型**：`owners` 是设备组。一组设备共用同一批 bot 和同一个队列；没有账号，加入只靠配对码；不做把 bot 分享给别人。`HONK_MAX_BOTS_PER_DEVICE`（名字不变）按设备组计数。

**同步、确认、清理**：`/v1/sync` 和 `GET /v1/messages/:id` 按 `owner_id` 查，游标仍是消息 id，由各设备自己保存，互不影响。`POST /v1/ack {up_to}` 抬高**这台设备**的水位 `devices.acked_up_to`（只升不降；上限是 `messages` 表发过的最大 id，免得一个过大的值盖住以后才有的消息）。清理删除：过期的；或 `id <= 组内 MIN(acked_up_to)` 且创建超过 `HONK_ACKED_KEEP` 的。一台一直不同步的设备会让消息留到过期为止。推送扇出和重试见上一节。

**配对**（密码学都在设备端，网关只存不透明的字符串）：

1. 旧设备生成 16 字节随机配对码，显示成 26 位 Crockford base32（`0-9A-Z` 去掉 `I L O U`，每 4 位一组，输入时不分大小写，`O` 当 `0`，`I`、`L` 当 `1`；最后一位里有 2 个补位的零，不符的当输入错误）。
2. `link_id` = HKDF-SHA256(code, 盐为空, info `"honk link id"`, 32 字节) 的 base64url（无填充，43 个字符）；`wrap_key` = 同样但 info 是 `"honk link key"`。
3. `bundle` = base64url(`nonce(12)` ‖ AES-256-GCM(wrap_key, nonce, 明文, AAD `"honk link v1"`) 的密文 ‖ `tag(16)`)，明文是 JSON `{"v":1,"tokens":{botId:token},"keys":{botId:base64url},"group_key":base64url}`。`keys`（第 7 期每个 bot 的端到端密钥）和 `group_key`（设备组的加密密钥）预留，没有时不出现；`keys` 只在本机存有时才放。旧设备只放自己存着 token 的 bot；整段密文不超过 16 KB（约百来个 bot）。
4. 旧设备 `POST /v1/links {link_id, bundle}`：网关只存 `link_id` 的 sha256，10 分钟有效，一个设备组同时只有一个有效配对（新建会顶掉旧的）。
5. 新设备先照常注册（这时它自成一组），再 `POST /v1/links/claim {link_id}`：网关在一个事务里把新设备**所在的整个组**（设备、bot、排队的消息）并入创建配对的组，删掉旧组，返回 `bundle` 并删除这条配对（只能用一次，过期的认领也会把它删掉）。并入后超过 bot 上限则整个事务回滚、配对保留，返回 400。认领按客户端 IP 限流（突发 5 次，之后每小时 10 次，`Options.ClaimBurst` / `ClaimPerHour`），猜不出 128 位的码。
6. 新设备解开 `bundle`，把 token（以后还有 `keys`、`group_key`）存好，把同步游标归零（队列里的消息是整个组的，id 比它旧游标小的也要拿），然后刷新。并入的设备水位清零，免得旧组里的 ack 盖住新组的消息。新设备拿不到：更早的本地历史、静音/置顶/已读、`local:` 头像。并入的另一侧（原来就在新设备所在组里的 bot）的 token 不在 bundle 里，别的设备上看得到这些 bot、能收消息，但没有 token 就不能发送。

代码：HonkKit 的 `DeviceLink.swift`（`PairingCode`、`LinkCrypto`、`LinkBundle`、`DeviceLinking`）和 `:core` 的 `DeviceLink.kt` 是同一套，`docs/link-vectors.json` 是两边测试共用的向量（用 Go 标准库独立生成）。网关不解 bundle，所以 Go 里没有这套代码。二维码：nsh 0.5 没有二维码或相机接口，第一版只有文字、复制和粘贴。

**设备管理**：注册时带 `name`（iOS `UIDevice.current.name`，Android `Build.MODEL`，最长 64 字）；`seen_at` 在设备认证通过的请求里写，距上次超过 1 小时才写。`GET /v1/devices` 列出本组设备（`current` 标出自己），`DELETE /v1/devices/:id` 移除组内一台（不在组内 404）。移除最后一台时连组、bot、队列、配对一起删；移除非最后一台时，它创建的 bot 的 `device_id` 先改给留下的设备。`DELETE /v1/devices/me` 等于移除自己，加 `?all=true` 删整个设备组。被别的设备移除或整组删除的设备，下次请求得到 401：iOS 和 Android 的 `refresh` 都会清掉凭据，用上次的推送 token 重新注册成一个新组。丢手机的恢复密钥不做。

**回收**：每小时随清理跑一次 `GCDevices`：`push_ok = 0` 且 `seen_at` 早于 `HONK_DEVICE_GC`（默认 `2160h`，90 天）的设备按「移除」处理，所以它是组里最后一台时，只属于它的 bot 和队列一起删。

### 推送中继（`internal/push/relay.go`、`internal/api/relay.go`）

官方 App 的 APNs / FCM 凭据只在官方网关手里，自建网关没有。某个平台没有直连凭据时，`Router` 对这个平台用 `push.Relay`：每条推送变成一次对中继网关的 HTTP 请求，中继不落盘地代发并把结果原样返回。App 照常只和自己的网关打交道。

```
发送方 → 自建网关（队列、内容）──POST /v1/relay/push──▶ 中继 ──▶ APNs / FCM ──▶ 设备
                                                                            │
自建网关 ◀──────────────── GET /v1/messages/:id（设备拉完整消息，填横幅）◀──────┘
```

**配置**：`HONK_RELAY_URL`（默认 `https://honk.bunship.site/`，`off` 关闭）、`HONK_RELAY_SERVE`、`HONK_PUSH_CONTENT`（`full` / `none`，默认直连 `full`、中继 `none`）、`HONK_RELAY_RATE` / `HONK_RELAY_BURST`（10 / 100）、`HONK_RELAY_TOKEN_PER_MINUTE`（60）。`config.PushRoute(platform)` 决定每个平台的路径：有直连凭据 → `direct`；否则开了 `HONK_RELAY_SERVE` 或 `HONK_RELAY_URL=off` → `off`（中继服务端从不再用中继，避免成环）；否则 `relay`。`off` 的平台不入队推送，App 只能在打开时同步到消息。启动时对每个走中继或 `off` 的平台写一条 Warn，说明路径、会经过中继的内容和怎么关。`HONK_RELAY_SERVE` 要求至少一个平台有直连凭据，否则 `config.Load` 拒绝启动。

**客户端**（`push.Relay`，实现 `Pusher`）：第一次推送时惰性登记：`POST /v1/relay/gateways` 拿到 `relay_id` 和 `relay_key`（只返回一次），连同中继地址存进 `meta`；中继地址变了就重新登记。之后 `POST /v1/relay/push`。状态码映射：200 → 成功；410 → `push.ErrTokenGone`（`MarkPushGone`，`push_ok=0`，和直连一样）；429 → `RetryableError`，`After` 取 `parameters.retry_after`（没有就取 `Retry-After` 头），由推送队列按第 4 节重试；5xx、网络错误、超时 → `RetryableError`；503 且说明没有凭据 → 永久错误；401 和其他 4xx → 永久错误，记 Error 日志，不重试。**401 的决定**：只有说明“key 未知”（中继丢了数据库）时才丢掉本地 key、重新登记并把这条推送再发一次，一小时最多一次；“已封禁”不重新登记，否则等于绕过封禁。

**请求字段**：`platform`、`token`、`kind`、`msg_id`、`target_id`、`bot_id`、`level`、`collapse_key`，`HONK_PUSH_CONTENT=full` 时再加 `bot_name`、`title`、`body`、`group`（正文截断同直连）。`collapse_key` 一律是 `b<bot>:<sha256(id) 前 16 字节 hex>`（`push.CollapseKeyFor`），中继看不到发送方原始的 `id`；中继用它直接做 `apns-collapse-id` / FCM `collapse_key`（`Notification.CollapseKey`）。

**服务端**（`api.Server.relayPush`，只在 `HONK_RELAY_SERVE=true` 时挂载 `/v1/relay/*`）：

- 登记：不需要账号，按客户端 IP 限流，规则同设备注册，但用单独的桶；生成 `relay_id`（`r` 加随机串）和 `relay_key`，库里只存 key 的 sha256。
- 推送：`Authorization: Bearer <relay_key>`；key 未知 → 401 `unknown relay key`，被封 → 401 `relay blocked`；每个自建网关一个令牌桶（`HONK_RELAY_RATE` / `BURST`），每个 push token（平台加 token 的哈希）每分钟 `HONK_RELAY_TOKEN_PER_MINUTE` 条，超了 429 并带 `parameters.retry_after` 和 `Retry-After` 头；请求体最大 8 KB（413）；字段校验失败 400。
- 只用直连 pusher（`Options.RelayAPNs` / `RelayFCM`，`cmd/honk` 填的是还没接中继的那份 `Router`），所以从不再转给别的中继；这个平台没有凭据 → 503。
- 结果：成功 200；`ErrTokenGone` → 410；可重试的失败带 `After` → 429，不带 → 502；其他失败 → 422。推送请求不写库（`last_used_at` 每分钟最多写一次），日志里没有 token。收到的推送没有 `bot_name`、`title`、`body` 就按无内容发。
- 降速：每个自建网关在内存里按一小时窗口记总数和 410 数；410 超过 100 条（`Options.RelayGoneLimit`）且占一半以上，令牌桶的速率和突发降到十分之一并记 Warn（含 relay id），窗口过完不再满足条件就恢复。封禁由人工：`UPDATE relays SET blocked = 1 WHERE id = '…'`。

**无内容的推送**（`HONK_PUSH_CONTENT=none` 或中继收到的请求没带文字，`Notification.Bare`）：APNs 的 `alert` 只有 `loc-key: "New notification"`（App 和 NSE 里都有 `ios/Localization/{en,zh-Hans}.lproj/Localizable.strings`），`thread-id` 不带 group，也没有自定义的 `id`，照常 `mutable-content: 1`；FCM 的 data 没有 `bot_name`、`title`、`body`、`group`、`id`。横幅文字由设备端决定：iOS 的 `BannerText.choose`（HonkKit）和 Android 的 `Banner.choose`（`:core`）取拉到的消息和本地 bot 的名称，拉不到就用推送里已有的文字，再不行就显示本地化的“新通知 / New notification”。Android 的通知 tag 也改成先拉消息，再用消息里的 collapse id（`Banner.tag`）；拉不到时用 `m<msg_id>`。这个开关对直连同样生效。

**指标**：`honk_pushes_total` 的 `route` 现在有 `direct` 和 `relay`（自建网关一侧）；中继一侧有 `honk_relay_requests_total{result}`（`ok`、`token_gone`、`rate_limited`、`unauthorized`、`blocked`、`no_credentials`、`bad_request`、`failed`、`registered`）和 `honk_relay_pushes_total{platform}`。

**App**：网关页测试连接时，`honk.gateway.test` 的结果多一个可选的 `push: {ios, android}`（来自 `/v1/info`，契约见 `host.contract.json`），页面显示每个平台的推送方式，`off` 时提示“只能在打开 App 时收到通知”。

### 运维

- `HONK_METRICS_ADDR`（默认空，不开）：在单独的监听地址提供 `/metrics`，Prometheus 文本格式，手写（`internal/metrics`），没有新依赖。计数：`honk_messages_total{kind}`、`honk_pushes_total{platform,route,result}`、`honk_push_retries_total`、`honk_push_dropped_total{reason}`（`queue_full`、`not_wanted`、`shutdown`）、`honk_http_requests_total{class}`；量表：`honk_devices`、`honk_bots`、`honk_push_queue_length`。`route` 是 `direct` 或 `relay`（见上一节），中继一侧另有 `honk_relay_requests_total`、`honk_relay_pushes_total`。
- `HONK_LOG_FORMAT=json` 输出 JSON 日志；`HONK_LOG_LEVEL=debug` 时每个请求记一条访问日志（`/bot<token>/…` 里的 token 替换成 `<token>`）。

### 命令行与 webhook 适配（发送方生态）

- **`dry_run`**：`sendMessage` 加 `dry_run=true` 只校验。`widget.Inspect` 是 `Clean` 的带报告版本，返回清理后的 HTML、输入和清理后的原文大小、zlib 9 压缩大小，以及被白名单删掉的元素和属性（每种只列一次）；`Clean` 就是它的包装。`dry_run` 不入队、不推送，但计入限流。
- **命令行**：同一个 `honk` 二进制。`cmd/honk/cli.go` 在 `main()` 开头分派：无参数或 `serve` 走原来的网关（环境变量配置不变），`send`、`edit`、`delete`、`me`、`preview`、`help` 交给 `internal/client`。`client.Client.Call` 向 `/bot<token>/<method>` POST JSON，失败的信封变成带 `description` 的错误，进程退出码 1（用法错误 2）；错误里不出现 token。地址和 token 优先级：命令行参数、`HONK_URL` / `HONK_TOKEN`、`~/.config/honk/config.json`。管道输入的标准输入作正文；`--html`、`--data` 的 `@文件` 读文件，data 会压成单行。`preview` 每次先 `dry_run` 打印大小和删除项，再用固定 `id`、`level=passive` 发送；`--watch` 轮询两个文件的修改时间和大小（500ms），不引依赖。
- **`--key`**：客户端按第 7 节的密文格式加密（`client.Encrypt`：AES-256-GCM，12 字节 nonce ‖ 密文 ‖ 16 字节 tag，无填充 base64url，AAD 是 token 冒号前的 bot id），把 title、body、html、data、url、copy、icon 放进一段 JSON，作为 `ciphertext` 发送；`edit` 加密 `{"data": …}`。网关还没有 `ciphertext` 参数（加密一期），所以现在只有发送端和单元测试，帮助文字和 README 都注明了。
- **webhook 适配**：`internal/hooks` 里每种格式一个纯函数 `Request → url.Values`（参数名就是 sendMessage 的），`hooks.Convert` 统一加上查询串覆盖（`level`、`group`、`icon`、`copy`、`url`、`title`）和空正文兜底。路由 `/{bot}/hook/{kind}[/*]` 在 `internal/api/hook.go`，鉴权用和 `botAPI` 同一个 `authBot`，转换后直接调用 `sendMessage`，所以限流、字段检查和卡片白名单完全一致；`ErrIgnored` 返回 `{"ignored":true}`。`alertmanager` / `grafana` 的 `id` 取 groupKey 的哈希（Grafana 单条告警取 fingerprint），自带的状态卡片所有文字都转义，并有测试保证它通过白名单且不被删减。`github` 不校验签名，token 就是密钥。`bark` 的 `<key>` 段被忽略。`json` 用 `$.a.b` 路径，由 `hooks.Lookup` 实现。
- **GitHub Action**：根目录 `action.yml`，composite，用 `jq` 拼 JSON、`curl` 发送，输入经环境变量传入，避免注入。
- **卡片手册**：`docs/CARDS.md`、`docs/CARDS.zh-CN.md`；`widget/docs_test.go` 抽出文档里每个 `html` 代码块，要求通过 `Inspect` 且没有任何删除，`json data` 代码块必须是 1 KB 以内的 JSON。

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
- 添加设备（`AddDevice`：配对码、复制、倒计时）和输入配对码（`Pair`）；设置页的「设备」区列出设备组，「数据」区分成「从设备组移除这台设备」（组里还有其他设备时才有）和「删除全部数据」

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
| `honk.devices.list` | | `{id, name, platform, seenAt, current}[]`（没注册时是空数组；老网关会失败，App 当作没有设备组） |
| `honk.devices.remove` | `{deviceId}` | 移除组里的一台；`deviceId` 是自己的 id 就是退出设备组：`DELETE /v1/devices/me`，成功后清空本机（同下），其他设备和 bot 不受影响 |
| `honk.link.create` | | 生成配对码，把本机存有 token 的 bot 封进 bundle，`POST /v1/links`；返回 `{code, expiresAt}`（`code` 已按 4 位分组） |
| `honk.link.claim` | `{code}` | 解析配对码（不分大小写、可带短横线或空格），`POST /v1/links/claim`，存下 bundle 里的 token，游标归零并刷新；码不对、过期、已用、尝试太多都会让调用失败并带上原因 |
| `honk.device.delete` | | 删除全部数据：先请求网关 `DELETE /v1/devices/me?all=true`（整个设备组；401 视为网关已忘记这台设备），成功后清空本机：本地库、凭据、bot token、`local:` 头像、已显示的通知（Android 还有 channel 和快捷方式），复用切换网关时的清空逻辑。网关失败就整个调用失败，本机不动。之后不立即重新注册：下次创建 bot（`honk.bot.create` 发现未注册会先注册）或重新打开 App（推送 token 到达时）才注册；这期间 `honk.status` 的 `registration` 是 `notRegistered` |
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
| `id` | `apns-collapse-id: b<bot>:<id>`（超过 64 字节时取哈希；经中继时一律是哈希） | `collapse_key`；data 里的 `id`，App 用它做通知 tag |
| 无内容的推送（`HONK_PUSH_CONTENT=none`） | `alert` 只有 `loc-key: "New notification"`；没有 bot 名称、标题、正文、group、`id` | data 里没有 `bot_name`、`title`、`body`、`group`、`id` |
| edit / delete | `content-available: 1` 后台推送 | priority NORMAL 的 data message |
| `silent` | 和 edit / delete 一样的 `content-available: 1` 后台推送（`kind` 仍是 `message`，没有 `alert`，NSE 不运行），App 在 `didReceiveRemoteNotification` 里 `apply` 这条消息，不发通知，计入角标 | NORMAL 优先级 data message，没有 `title` / `body`，带 `silent: 1`；App 拉到消息后只入库，不发通知 |
| `ttl` | `apns-expiration` = 现在 + ttl（不填 24 小时） | `android.ttl`（秒；不填 86400s）；两者都不超过 FCM 的上限 28 天 |
| `image`、`open`、`parse_mode` | 不进推送，设备拉到消息后再用（Markdown 消息的 `alert.body` 是去掉标记的文本） | 同左（`body` 是去掉标记的文本） |

### 通知动作和附图

动作由消息的字段决定（纯函数在 HonkKit 的 `NotificationPlan.swift` 和 `:core` 的 `NotificationPlan.kt`，两边同样的测试）：`copy` 非空时有「复制」，`url` 是 http(s) 时有「打开链接」，总有「标为已读」。

- iOS：启动时注册 4 个 category（`honk.msg`、`honk.msg.copy`、`honk.msg.url`、`honk.msg.copy.url`），NSE 按消息设 `categoryIdentifier`；`AppDelegate` 处理动作（复制到剪贴板、打开链接、标这个 bot 已读）。`open=url` 时点通知本体打开 `url`，否则进会话。NSE 下载 `image`（只收 https，≤ 5 MB，10 秒超时，JPEG / PNG / GIF / WebP）到临时文件，作为 `UNNotificationAttachment`。`threadIdentifier` 是 `bot-<id>`，有 `group` 时是 `bot-<id>:<group>`。
- Android：`Notifier` 给通知加 `NotificationCompat.Action`；「复制」和「标为已读」走清单里注册的 `NotificationActionReceiver`（用 `goAsync` 在后台线程里读库），「打开链接」和 `open=url` 的点击是直接的 `ACTION_VIEW` activity intent（Android 12 起不允许 receiver 里再起 activity）。有 `image` 时用 `BigPictureStyle`（头像放在 large icon），下载 ≤ 5 MB、10 秒超时，缩到 1024 像素以内；没有图时仍是 MessagingStyle。
- `silent` 的消息两端都入库、计入未读和角标，不发通知（`NotificationPlan.shouldNotify`）。
- App 里：气泡顶部显示 `image`；`parse_mode=Markdown` 的正文由 `app/src/markup.ts` 解析（粗体 `**` / `__`、斜体 `*` / `_`、行内代码、代码块、`[文字](url)` 链接、`-` `*` `+` 和 `1.` 列表、`#` 标题画成粗体），链接只认 http(s)；没有 `parse_mode` 时正文里的 `https://` 链接自动识别成可点（句末标点不算在链接里）。

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
- [ ] 推送中继只在测试里用两个 `httptest` 网关首尾相接验证过，还没有对着真实的官方中继、APNs / FCM 跑过；iOS 的 `Localizable.strings` 和 NSE 的横幅改动、Android 的 `Banner` 接线只在 CI 里编译
- [ ] 在有 GMS 的设备或模拟器上跑通 FCM、通知和 nsh 界面（CI 的 `android` job 已用 Android SDK 跑 `:core:test` 并构建 debug 版）
- [ ] 后台刷新（iOS `BGAppRefreshTask`、Android WorkManager 每 6 小时）、「删除全部数据」、设备组和配对的原生代码只在 CI 里编译，没在真机上跑过；Android 的后台同步还不补发通知
- [ ] Android 预设头像现在画的是 bot 名称首字，和 App 内的图标不一致；可以给 Android 加一套对应的矢量图标
- [ ] 设备组配对：网关、HonkKit 和 `:core`（含共用的 HKDF / AES-GCM 向量）都有测试，两端 App 的接线（`ios/App`、`android/app`）只在 CI 里编译；没有二维码（nsh 0.5 无二维码接口）；`keys` / `group_key` 字段已预留，等第 7 期的密钥存储接上
- [x] 卡片 profile 2：JS（宿主里的 quickjs-ng）、`TelegramWidget` 兼容接口
- [ ] 卡片按钮回调：沙箱一侧已就绪（`request()`、`honk_card_answer`），网关的 `answerWidgetQuery`、webhook / 长轮询和宿主接线随同一个版本；`publicData` / 共享卡片
- [ ] 卡片脚本在真机上的耗时和内存还没测过；pointer 事件、canvas 没有
- [ ] 推送内容端到端加密（参考 Bark 的 ciphertext），消息在网关上只存密文
- **nsh 还是 0.5.x**：推送和扩展全部用原生写，nsh 只负责 App 内界面，把升级的影响面控制在 UI 层。
- **NSE 资源有限**：NSE 内存约 24MB、运行约 30 秒，所以只做拉取、写库和渲染头像，不加载 nsh。
