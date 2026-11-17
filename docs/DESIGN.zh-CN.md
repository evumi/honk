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
| `ios/App/`、`ios/NotificationService/` | iOS 宿主和 Notification Service Extension；XcodeGen 生成工程 | 已实现，**尚未在 Xcode 中编译验证** |
| `app/` | nsh App（TSX）：会话列表、消息流、卡片渲染、创建和设置 bot | 已实现，有 `nsh test` 测试 |
| `android/` | Kotlin 宿主和 FirebaseMessagingService | 未开始 |

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

## 4. 网关（gateway/）

### 数据表

见 `gateway/internal/store/schema.sql`。时间戳都是 Unix 毫秒。

- `devices`：`id`（UUIDv7）、`secret_hash`、`platform`（ios / android）、`push_token`、`push_ok`（APNs/FCM 报告 token 失效后置 0）
- `bots`：`id`（自增整数）、`device_id`、`token_hash`、`name`、`avatar`、`default_level`
- `messages`：队列。`kind` 是 message / edit / delete；edit 和 delete 用 `target_id` 或 `collapse_id` 指向原消息

bot token 形如 `<bot id>:<32 位随机串>`；token 和 device secret 都只存 sha256。

### 接口

所有返回都用 Telegram 的格式：`{"ok":true,"result":…}` 或 `{"ok":false,"error_code":N,"description":"…"}`。

| 接口 | 调用方 | 说明 |
| --- | --- | --- |
| `/bot<token>/sendMessage` | 发送方 | `body` 必填；`title`、`html`、`data`、`level`、`group`、`id`、`url`、`copy`、`icon` 可选；GET 查询串、表单、JSON 都行 |
| `/bot<token>/editMessageData` | 发送方 | `message_id` 或 `id` + `data`，卡片原地更新，不弹通知 |
| `/bot<token>/deleteMessage` | 发送方 | `message_id` 或 `id` |
| `/bot<token>/getMe` | 发送方 | 测试 token |
| `POST /v1/devices` | App | 注册，返回 `device_secret`（只返回这一次） |
| `GET` / `PUT` / `DELETE /v1/devices/me` | App | 读取；更新 push token；删除设备及全部数据 |
| `GET` / `POST /v1/bots`，`GET` / `PATCH` / `DELETE /v1/bots/:id`，`POST /v1/bots/:id/token` | App | bot 管理；token 只在创建和重置时返回 |
| `GET /v1/messages/:id` | NSE / FCM Service | 拉一条 |
| `GET /v1/sync?cursor=&limit=`、`POST /v1/ack` | App | 补拉和确认 |

### 校验与限制

- **卡片**（`internal/widget`）：原文 ≤ 32KB，zlib 9 压缩后 ≤ 4KB，`data` ≤ 1KB。按白名单清理：删掉脚本、`on*` 属性、表单控件、外部资源；链接只允许 `https://`、`#id`、`{{key}}`；CSS 里禁止 `@import`、`expression()`、非 data: 的 `url()` 和反斜杠转义。
- **字段长度**：`title` ≤ 256 字，`body` ≤ 4096 字，`id` ≤ 128 字节，`icon` 必须是 https。
- **限流**：每个 bot 每秒 5 条，突发 20 条（可配）。
- **清理**：每小时删除过期和 ack 超过 1 天的消息。

## 5. iOS（ios/）

工程由 XcodeGen 从 `project.yml` 生成，有两个 target：

- `Honk`：App，界面全部由 nsh 渲染（`NativeShell.xcframework`）
- `NotificationService`：NSE

两者都依赖本地 Swift 包 `HonkKit`。

### HonkKit

| 文件 | 作用 |
| --- | --- |
| `APIClient.swift` | `/v1` 接口客户端 |
| `Credentials.swift` | 设备凭据和各 bot token 存 Keychain，用共享 access group，`AfterFirstUnlock`，NSE 在锁屏时也能读 |
| `LocalStore.swift` | App Group 里的 SQLite，WAL + busy timeout，App 和 NSE 两个进程共用。`apply()` 处理 message / edit / delete，重复调用安全，返回需要撤掉的系统通知 id |
| `Honk.swift` | `HonkConfig`（从 Info.plist 读网关地址、App Group、Keychain 组）；`ChangeSignal`（Darwin 通知，NSE 写库后通知 App 刷新）；`SyncEngine`（分页拉取、应用、ack） |
| `Avatar.swift` | 头像格式 `preset:<icon>:<#rrggbb>` 或 https URL；图片缓存到 App Group |
| `CommunicationNotification.swift` | iOS 15 通讯通知：`INSendMessageIntent` + bot 头像 |

### NSE 流程

1. 从 `userInfo` 读 `msg_id`、`bot_id`
2. 读 Keychain 凭据，调 `GET /v1/messages/:id`
3. `LocalStore.apply(..., notificationID: request.identifier)` 记下这条消息对应哪个系统通知，之后删除或被替换时用来撤回
4. 设置角标（本地未读数，静音的 bot 不算）；静音的 bot 改成 passive、无声
5. 渲染头像（预设图标用 SF Symbol 画在色块上；https 头像先下载，5 秒超时），转成通讯通知
6. `ChangeSignal.post()` 通知 App

任何一步失败，都照常显示推送自带的横幅。

### App

- `AppDelegate`：申请通知权限，注册推送；收到静默推送就拉取并应用修改或删除；正在看的会话来消息时不弹横幅；点击通知时，有 `url` 就打开，否则进入对应会话。
- `HonkService`：注册或更新 push token（网关返回 401 时自动重新注册）、刷新 bot 列表、同步、角标。
- `RootViewController`：全屏 `NshAppView`。加载 `nsh/bundle.nshc`，按 `capabilities.json` 授权；设置了环境变量 `NSH_DEV_URL` 时改连 `nsh dev` 做热更新。
- `NshBridge`：nsh App 调用的 `honk.*` 宿主函数，见第 6 节。

### 配置

- `Config/Base.xcconfig`：bundle ID、App Group、Keychain 组、网关地址
- `Config/Local.xcconfig`（不入库）：自己的 `DEVELOPMENT_TEAM` 和网关地址
- Capabilities：Push Notifications、App Groups、Keychain Sharing、Communication Notifications、Time Sensitive Notifications

## 6. nsh App（app/）与宿主协议

App 用 TSX 写，跑在 QuickJS 上。页面：

- 会话列表（`Home`，带底部标签栏）
- 会话详情（`Chat`）
- 新建 Bot（`NewBot`）
- 创建成功（`BotCreated`）
- Bot 设置（`BotSettings`）

没有宿主时（例如在桌面上 `nsh run`）自动使用 `src/demo.ts` 的内存数据，方便单独调界面。

宿主协议定义在 `app/src/host.ts` 和 `ios/App/NshBridge.swift`，两边要同步修改。

| 调用 | 参数 | 返回 |
| --- | --- | --- |
| `honk.status` | | `{registered, gatewayURL, notifications}` |
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
| `honk.notifications.open` | | 打开系统设置 |

宿主发给 App 的事件有两个：

- `honk.changed`：本地库有变化，App 重新加载
- `honk.open {botId}`：用户点了通知，打开对应会话

静音和置顶只存在本地，不上传网关。

### 卡片渲染（profile v1）

代码在 `app/src/widget/`。

1. `parse.ts`：容错的 HTML 子集解析器；`fill()` 用 `data` 填 `{{key}}` 占位符，style 属性里的占位符也会填
2. `Widget.tsx`：
   - 块级元素渲染成 `View`，连续的行内内容合并成一个带嵌套 span 的 `Text`
   - flex 容器的子元素按 flex item 处理，`inline-flex` / `inline-block` 宽度跟随内容，带尺寸或背景的行内元素渲染成盒子
   - CSS 子集映射到 nsh 样式：布局、间距、边框、圆角、颜色、字体、阴影、渐变
   - `var(--tg-theme-*)` 从当前主题取色，深色模式自动切换
   - `https://` 链接和 `button[data-url]` 点击后用系统打开
   - 超过 2000 个节点时不渲染卡片，只显示正文
3. **v1 不执行 JS**。v2 计划在 QuickJS 里做精简 DOM，并提供和 `TelegramWidget` 同名的接口。

## 7. 推送字段映射

| 字段 | APNs | FCM |
| --- | --- | --- |
| bot 名称 / `title` / `body` | `alert.title` / `alert.subtitle` / `alert.body`，`mutable-content: 1` | data 里的 `bot_name`、`title`、`body`，由 App 建通知 |
| `level=passive` | `interruption-level: passive`，priority 5，无声 | priority NORMAL |
| `level=active` | `interruption-level: active` | priority HIGH |
| `level=timeSensitive` | `interruption-level: time-sensitive` | priority HIGH |
| `group` | `thread-id: b<bot>:<group>` | data 里的 `group` |
| `id` | `apns-collapse-id: b<bot>:<id>`（超过 64 字节时取哈希） | `collapse_key` |
| edit / delete | `content-available: 1` 后台推送 | priority NORMAL 的 data message |

## 8. 本地开发

```bash
cd gateway && make test && make run      # 网关，:8080
cd ios && make test                      # HonkKit 测试（只有 Command Line Tools 也能跑）
cd app && nsh test && nsh run App.tsx    # nsh App 测试；在桌面上用演示数据运行
cd ios && make setup                     # 下载 nsh 框架并生成 Xcode 工程（需要 XcodeGen）
```

真机联调需要：

- `Local.xcconfig` 里填好团队和网关地址
- 网关配置 APNs `.p8` key；开发版构建要设 `HONK_APNS_SANDBOX=true`

## 9. 待办与风险

- [ ] 在装了 Xcode 的机器上编译 iOS 工程，修正类型错误，真机跑通 APNs
- [ ] Android 宿主：FirebaseMessagingService、每个 bot 一个 NotificationChannel、MessagingStyle 头像
- [ ] 卡片 v2：JS、`TelegramWidget` 兼容接口、按钮回调（需要 bot webhook）
- [ ] 推送内容端到端加密（参考 Bark 的 ciphertext），消息在网关上只存密文
- **nsh 还是 0.5.x**：推送和扩展全部用原生写，nsh 只负责 App 内界面，把升级的影响面控制在 UI 层。
- **NSE 资源有限**：NSE 内存约 24MB、运行约 30 秒，所以只做拉取、写库和渲染头像，不加载 nsh。
