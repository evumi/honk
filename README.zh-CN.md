# Honk

[English](README.md)

Honk 是一个以 bot 为渠道的推送通知服务：每个 bot 都是一个独立的通知渠道，消息可以附带一张小型 HTML 卡片，格式参照 Telegram Bot API 10.4 的 HTML widget。iOS 通过 APNs 推送，Android 通过 FCM 推送（只支持带 GMS 的设备）。

## 仓库结构

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `gateway/` | Go + SQLite 网关：bot API、App API、短期消息队列、APNs/FCM 推送 | 第一版 |
| `app/` | nsh App（TSX）：会话列表、消息流、卡片渲染 | 第一版 |
| `ios/` | Swift 宿主、Notification Service Extension、共享包 HonkKit | 第一版（未在 Xcode 中编译验证） |
| `android/` | Kotlin 宿主和 FirebaseMessagingService | 未开始 |

开发设计文档见 [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md)，界面稿和截图见 [docs/design](docs/design/)。

## 工作方式

1. App 启动时把 APNs/FCM 的 push token 注册到网关，拿到 `device_secret`。
2. App 创建 bot，拿到 bot token，形如 `1:Gw2K7mx…`。
3. 发送方调用 `/bot<token>/sendMessage`。网关把消息写进队列，然后推送一条只带横幅文字和 `msg_id` 的通知。
4. 设备端（iOS 的 NSE 或 Android 的 FCM Service）按 `msg_id` 调 `GET /v1/messages/:id` 拉完整消息（包括卡片），存进本地库。
5. App 打开时调 `GET /v1/sync` 补齐离线期间漏掉的消息，存好后调 `POST /v1/ack`。

队列里的消息默认保存 7 天；已 ack 的消息保留 1 天后删除。

## 运行网关

```bash
cd gateway
make run        # 不配推送凭据也能跑：推送会记日志后跳过
make test
```

Docker：

```bash
docker build -t honk gateway
docker run -p 8080:8080 -v honk-data:/data \
  -v /path/AuthKey_XXXX.p8:/secrets/apns.p8:ro \
  -v /path/service-account.json:/secrets/fcm.json:ro \
  -e HONK_APNS_KEY_FILE=/secrets/apns.p8 -e HONK_APNS_KEY_ID=XXXX \
  -e HONK_APNS_TEAM_ID=YYYY -e HONK_APNS_TOPIC=com.example.honk \
  -e HONK_FCM_CREDENTIALS_FILE=/secrets/fcm.json honk
```

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HONK_ADDR` | `:8080` | 监听地址 |
| `HONK_DB` | `./data/honk.db` | SQLite 文件路径 |
| `HONK_MESSAGE_TTL` | `168h` | 消息在队列里保存多久 |
| `HONK_ACKED_KEEP` | `24h` | 已 ack 的消息再保留多久 |
| `HONK_SEND_RATE` / `HONK_SEND_BURST` | `5` / `20` | 每个 bot 每秒最多发几条 / 突发上限 |
| `HONK_APNS_KEY_FILE` | | APNs `.p8` key 文件路径；不设就不推 iOS |
| `HONK_APNS_KEY_ID` / `HONK_APNS_TEAM_ID` / `HONK_APNS_TOPIC` | | 设置了 key 文件时必填；topic 就是 bundle ID |
| `HONK_APNS_SANDBOX` | `false` | 用 APNs 开发环境，开发版构建要设为 true |
| `HONK_FCM_CREDENTIALS_FILE` | | Firebase service account JSON；不设就不推 Android |

## Bot API

地址是 `/bot<token>/<method>`，参数可以放在 GET 查询串、表单或 JSON 里。返回格式和 Telegram 一样：`{"ok":true,"result":…}` 或 `{"ok":false,"error_code":400,"description":"…"}`。

### sendMessage

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `body` | 是 | 正文，最多 4096 字符。横幅显示它，卡片下方也显示它；客户端不支持卡片时就只显示它 |
| `title` | | 标题，最多 256 字符 |
| `html` | | 卡片 HTML：原文最多 32 KB，zlib 压缩后最多 4 KB |
| `data` | | 卡片数据，最多 1 KB，通常是 JSON；用来填卡片里的 `{{key}}` 占位符 |
| `level` | | `passive`、`active` 或 `timeSensitive`；不填用 bot 的默认级别 |
| `group` | | 同一 bot 内的通知分组 |
| `id` | | 可替换 id：同一个 bot 再发相同 `id` 的消息，会替换掉之前那条 |
| `url` | | 点击通知时打开的链接，http(s) |
| `copy` | | 长按菜单里「复制」用的文字 |
| `icon` | | 这条消息的头像，必须是 https；不填用 bot 头像 |

```bash
curl https://honk.example.com/bot$TOKEN/sendMessage \
  -d title="部署成功" -d body="sub2api / sluice 已上线" -d id=dep-42 \
  --data-urlencode 'html=<div><b>{{status}}</b></div>' -d 'data={"status":"已上线"}'
```

### editMessageData

修改卡片数据，不弹新通知。用 `message_id` 或 `id` 指定是哪条消息，`data` 是新数据。

### deleteMessage

删除消息，并撤回已经显示的系统通知。用 `message_id` 或 `id` 指定。

### getMe

返回这个 bot 的信息，可以用来测试 token 是否有效。

### 卡片 HTML（profile v1）

网关只保留白名单里的元素，其他元素连同子元素一起删掉：

- 文本和结构：`div`、`span`、`p`、`h1`–`h6`、列表、`table`、`details`、`pre`、`code`
- 交互：`button`、`a`
- 样式：`style`
- 图片：`img`（只接受 `data:` 图片）
- 内联 SVG

以下内容会被删除：

- 脚本、`on*` 事件属性、表单控件
- 外部链接；`a` 只允许 `https://`、`#id` 或 `{{key}}`
- CSS 里引用外部资源的写法：`@import`、`expression()`、非 data: 的 `url()`

渲染时客户端还会再按自己的 CSS 白名单过滤一遍。

## App API

除了注册设备，其他接口都需要带 `Authorization: Bearer <device_secret>`。

| 接口 | 说明 |
| --- | --- |
| `POST /v1/devices` | `{"platform":"ios"\|"android","push_token":"…"}`，返回 `device` 和 `device_secret` |
| `GET` / `PUT` / `DELETE /v1/devices/me` | 读取设备信息；更新 push token；删除设备及它的所有 bot 和消息 |
| `GET` / `POST /v1/bots` | 列出 bot；创建 bot：`{"name","avatar","default_level"}`，返回 `bot` 和 `token` |
| `GET` / `PATCH` / `DELETE /v1/bots/:id` | 读取、修改、删除一个 bot |
| `POST /v1/bots/:id/token` | 重置 token，旧 token 立即失效 |
| `GET /v1/messages/:id` | 拉一条消息；条目可能是 `message`、`edit` 或 `delete` |
| `GET /v1/sync?cursor=&limit=` | 拉 cursor 之后的消息，返回 `messages`、`cursor`、`has_more` |
| `POST /v1/ack` | `{"up_to": <id>}`：告诉网关这个 id 及之前的消息都已存好 |

`edit` 和 `delete` 条目用 `target_id` 或 `id` 指向原消息。原消息可能已经从队列删掉了，客户端要对自己本地存的那份执行。
