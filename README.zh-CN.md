# Honk

[English](README.md)

![Honk：会话列表、带卡片的会话、新建 Bot、Bot 设置](docs/screenshots/zh.png)

Honk 是一个以 bot 为渠道的推送通知服务：每个 bot 都是一个独立的通知渠道，消息可以附带一张小型 HTML 卡片，格式参照 Telegram Bot API 10.4 的 HTML widget。iOS 通过 APNs 推送，Android 通过 FCM 推送（只支持带 GMS 的设备）。

## 仓库结构

| 目录 | 内容 | 状态 |
| --- | --- | --- |
| `gateway/` | Go + SQLite 网关：bot API、App API、短期消息队列、APNs/FCM 推送 | 第一版 |
| `app/` | nsh App（TSX）：会话列表、消息流、卡片渲染 | 第一版 |
| `ios/` | Swift 宿主、Notification Service Extension、共享包 HonkKit | 第一版；CI 的 `iosapp` job 构建模拟器版，尚未在真机上验证 |
| `android/` | Kotlin 宿主（嵌入 nsh App）、FirebaseMessagingService、共享模块 `:core`（网关客户端、本地库、同步） | 第一版；`:core` 在 JVM 上测试，CI 的 `android` job 构建 App，尚未在真机上验证 |

开发设计文档见 [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md)，界面稿和截图见 [docs/design](docs/design/)。

## 工作方式

1. App 启动时把 APNs/FCM 的 push token 注册到网关，拿到 `device_secret`。
2. App 创建 bot，拿到 bot token，格式是 `<bot id>:<secret>`，形如 `aZ3kQ9xT:Gw2K7mx…`。bot id 是 8 位随机 base62 字符（以字母开头），不是自增序号。
3. 发送方调用 `/bot<token>/sendMessage`。网关把消息写进队列，然后推送一条只带横幅文字和 `msg_id` 的通知。
4. 设备端（iOS 的 NSE 或 Android 的 FCM Service）按 `msg_id` 调 `GET /v1/messages/:id` 拉完整消息（包括卡片），存进本地库。
5. App 打开时调 `GET /v1/sync` 补齐离线期间漏掉的消息，存好后调 `POST /v1/ack`。

队列里的消息默认保存 7 天；设备组里每台设备都 ack 过的消息，在创建满 1 天（`HONK_ACKED_KEEP`）后删除。

推送失败而且可能恢复时（网络错误、超时、5xx、带 `retry_after` 的 429），网关从内存里的有界队列重试：2 秒、10 秒、60 秒后各一次，一共发 4 次；这台设备在这期间已 ack 这条消息、或者它的 push token 换了，就放弃。重试状态不跨重启保存，设备仍能从 `/v1/sync` 拿到消息。App 还会在后台大约每 6 小时同步一次（iOS 用 `BGAppRefreshTask`，Android 用 WorkManager）：应用修改和删除、更新角标，但不会补发通知。

## 多台手机：设备组

手机不再和 bot 绑死：配过对的设备组成一个**设备组**，共用同一批 bot 和同一个队列。每条消息（包括修改和删除）会推送给组里每一台能收推送的设备；每台设备有自己的同步游标和 ack 水位，慢的手机不会因为快的手机而丢消息。消息在过期后删除，或者组里每台设备都 ack 过、并且创建超过 `HONK_ACKED_KEEP` 后删除。静音、置顶、已读各手机自己保存，更早的本地历史不会迁移（只有队列里还没过期的消息会到新手机）。

换手机或加一台：在旧手机打开「设置 → 设备 → 添加设备」，会显示 26 位配对码（16 个随机字节的 Crockford base32，每 4 位一组；nsh 没有二维码接口，所以只有文字，可以复制）。新手机用「已有设备？输入配对码」（设置页，或没有 Bot 时的首页）。配对码 10 分钟内有效，只能用一次；网关看不到它，只存放由它经 HKDF-SHA256 派生出的 `link_id`，以及用派生密钥加密过的 bot token。新手机原有的 bot 也会并入设备组。认领按客户端 IP 限流，猜不出配对码。丢了手机又没有其他设备时不能恢复：bot token 只存在设备上，请重新创建 bot。

「设置 → 设备」列出设备组（名称、平台、最近在线、这台设备），可以移除其中一台。「数据」里有两个按钮：「从设备组移除这台设备」（这台手机退出，bot 留给其他设备）和「删除全部数据」（网关上整个设备组的设备、bot 和队列，再清空本机）。push token 已失效、且超过 `HONK_DEVICE_GC`（默认 90 天）没有任何请求的设备，网关会自动删除；它是组里最后一台时，bot 和队列一并删除。

## 手机上的消息

下面这些都只在设备端，不经过网关。

- **搜索**：会话列表的搜索框同时搜消息（标题和正文），结果列在匹配的会话下面；点一条消息，打开对应会话并停在那条消息上。
- **保留期限**：设置里可选永久（默认）、1 年、90 天、30 天。更早的消息在 App 启动和每次同步时从手机上删除，不影响网关。
- **导出与导入**：Bot 设置里导出单个会话，设置里导出全部，格式是 JSON Lines（每行一条消息，字段同 App API 的消息对象，另有 `bot_id`），走系统分享面板；设置里也可以把这样的文件导入回来。重复导入同一个文件没有变化；属于手机上没有的 Bot 的消息会被跳过。
- **iPad**：iOS App 支持 iPad，页面是居中的一列，最宽 600 点。
- Android 通知里的预设头像和 App 里的图标一样。

## 运行网关

自己部署网关见 [docs/SELF-HOSTING.zh-CN.md](docs/SELF-HOSTING.zh-CN.md)（Docker Compose、反向代理和 TLS、备份、升级）。

```bash
cd gateway
make run        # 不配推送凭据也能跑（关闭中继）：推送直接跳过
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
| `HONK_ACKED_KEEP` | `24h` | 设备组里每台设备都已 ack 的消息再保留多久（从创建时算起） |
| `HONK_DEVICE_GC` | `2160h` | push token 已失效、且这么久没有任何请求的设备会被删除；它是组里最后一台时，bot 和队列一并删除 |
| `HONK_SEND_RATE` / `HONK_SEND_BURST` | `5` / `20` | 每个 bot 每秒最多发几条 / 突发上限 |
| `HONK_REGISTER_PER_HOUR` | `10` | 每个 IP 每小时最多注册几台设备（突发 5） |
| `HONK_MAX_BOTS_PER_DEVICE` | `100` | 每个设备组最多几个 bot（名字沿用分组之前的叫法）；会超出上限的配对会被拒绝 |
| `HONK_WEBHOOK_ALLOW_PRIVATE` | `false` | 允许 bot 用 `setWebhook` 把地址设在回环、内网和链路本地地址上（默认拒绝，防止 bot 让网关去访问你的内网） |
| `HONK_APNS_KEY_FILE` | | APNs `.p8` key 文件路径；不设就不推 iOS |
| `HONK_APNS_KEY_ID` / `HONK_APNS_TEAM_ID` / `HONK_APNS_TOPIC` | | 设置了 key 文件时必填；topic 就是 bundle ID |
| `HONK_APNS_SANDBOX` | `false` | 用 APNs 开发环境，开发版构建要设为 true |
| `HONK_FCM_CREDENTIALS_FILE` | | Firebase service account JSON；不设就不推 Android |
| `HONK_PUSH_QUEUE` / `HONK_PUSH_WORKERS` | `1024` / `16` | 推送队列最多排几条（满了就丢弃并计数）/ 同时在发的推送数 |
| `HONK_RELAY_URL` | `https://honk.bunship.site/` | 没配直连凭据的平台走这个推送中继；`off` 关闭（该平台就收不到推送）。见[推送中继](#推送中继) |
| `HONK_RELAY_SERVE` | `false` | 对外提供 `/v1/relay/*`；至少一个平台配了直连凭据才能开，否则拒绝启动 |
| `HONK_PUSH_CONTENT` | 直连 `full`，中继 `none` | `full` 在推送里带 bot 名称、标题、正文，`none` 只带 id（APNs 在设备拉到消息之前显示“新通知”）。设了就对两条路径都生效 |
| `HONK_RELAY_RATE` / `HONK_RELAY_BURST` | `10` / `100` | 中继端：每个自建网关每秒条数 / 突发 |
| `HONK_RELAY_TOKEN_PER_MINUTE` | `60` | 中继端：每个 push token 每分钟条数 |
| `HONK_REGISTER_KEY` | | 设了以后 `POST /v1/devices` 必须带相同的 `register_key`，`/v1/info` 会返回 `register_key_required`。App 的网关页有可选的「注册口令」输入框 |
| `HONK_METRICS_ADDR` | | 例如 `127.0.0.1:9100`：在单独的端口提供 Prometheus 文本格式的 `/metrics`；留空就不开 |
| `HONK_LOG_FORMAT` | `text` | 设成 `json` 输出结构化日志 |
| `HONK_LOG_LEVEL` | `info` | 设成 `debug` 会再记录每个请求（路径里的 bot token 不会出现在日志里） |

`/metrics` 有 `honk_messages_total{kind}`、`honk_pushes_total{platform,route,result}`（`route` 为 `direct` 或 `relay`；结果是 `ok`、`retry`、`token_gone`、`failed`）、中继上的 `honk_relay_requests_total{result}` 和 `honk_relay_pushes_total{platform}`、`honk_push_retries_total`、`honk_push_dropped_total{reason}`、`honk_http_requests_total{class}`，以及量表 `honk_devices`、`honk_bots`、`honk_push_queue_length`。

## 推送中继

APNs 和 FCM 只接受带已发布 App 凭据签名的推送，自建网关手里没有这些凭据。某个平台没有凭据时，网关把每条推送换成一次对中继（默认是官方网关 `https://honk.bunship.site/`）的 HTTP 请求，由中继交给 APNs 或 FCM 并把结果返回。App 仍然只和你自己的网关打交道，注册流程不变。启动日志会写明每个平台走哪条路。

1. 发送方在你的网关上调用 `sendMessage`，队列和内容都在你的网关里。
2. 你的网关把 push token、`msg_id`、bot id、打扰级别和哈希过的 collapse key 发给中继。
3. 中继把推送交给 APNs/FCM，唤醒设备。
4. 设备向你的网关 `GET /v1/messages/:id` 拉完整消息，用它填横幅。

默认中继推送**不带内容**（`HONK_PUSH_CONTENT=none`）：没有 bot 名称、标题、正文，发送方的 `id` 也只以哈希出现。iOS 在 NSE 拉到消息之前显示本地化的“新通知”，拉到后换成真实文字；Android 同样用拉到的消息。设成 `HONK_PUSH_CONTENT=full` 时，bot 名称、标题、正文（按横幅长度截断）和直连一样经过中继和 Apple/Google。中继不保存推送，只有已登记网关的表（id、key 的哈希、时间、`blocked`）和内存计数器。

协议（沿用 Telegram 的 `{"ok":…}` 格式）：

- `POST /v1/relay/gateways`：不需要账号，登记一个网关，返回一次 `relay_id` 和 `relay_key`，网关存进自己的 `meta` 表。按客户端 IP 限流，规则同设备注册。
- `POST /v1/relay/push`：`Authorization: Bearer <relay_key>`，JSON 字段 `platform`、`token`、`kind`、`msg_id`、`target_id`、`bot_id`、`level`、`collapse_key`，有的话还有 `silent`（静默消息）和 `ttl`（推送为离线设备保留的秒数）（`full` 时再加 `bot_name`、`title`、`body`、`group`）。请求体最大 8 KB。
- 响应：200 已发出；410 token 失效（网关照直连处理，标记失效）；429 带 `parameters.retry_after`（由推送队列重试）；401 key 未知或被封（不重试；key 未知时网关重新登记，一小时最多一次，被封则不会）；503 中继没有这个平台的凭据（不重试）；5xx 和网络错误会重试。

提供中继：在配好自己凭据的网关上设 `HONK_RELAY_SERVE=true`。中继只用直连凭据发送，从不再转给别的中继。每个自建网关和每个 push token 都有限流；一小时内发往失效 token 的推送超过 100 条且占一半以上的网关会被降速并记日志，用 `UPDATE relays SET blocked = 1 WHERE id = '…'` 可以封禁。`/v1/info` 的 `features` 含 `"relay"`；所有网关都用 `push: {"ios","android"}`（`direct`、`relay` 或 `off`）报告推送方式，App 网关页测试连接时会显示。

## Bot API

地址是 `/bot<token>/<method>`，参数可以放在 GET 查询串、表单或 JSON 里。返回格式和 Telegram 一样：`{"ok":true,"result":…}` 或 `{"ok":false,"error_code":400,"description":"…"}`。

### sendMessage

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `body` | 是 | 正文，最多 4096 字符。横幅显示它，卡片下方也显示它；客户端不支持卡片时就只显示它 |
| `title` | | 标题，最多 256 字符 |
| `html` | | 卡片 HTML：原文最多 32 KB，zlib 压缩后最多 4 KB |
| `ciphertext` | | 端到端加密的内容，替代 `title`、`body`、`html`、`data`、`url`、`copy`、`icon`（见[端到端加密](#端到端加密)）；bot 打开加密后必须用它。此时 `body` 不必填，最大 64 KB |
| `data` | | 卡片数据，最多 1 KB，通常是 JSON；用来填卡片里的 `{{key}}` 占位符 |
| `level` | | `passive`、`active` 或 `timeSensitive`；不填用 bot 的默认级别 |
| `group` | | 同一 bot 内的通知分组 |
| `id` | | 可替换 id：同一个 bot 再发相同 `id` 的消息，会替换掉之前那条 |
| `url` | | 消息的链接，http(s)：在会话里点这条消息时打开 |
| `copy` | | 长按菜单里「复制」用的文字 |
| `icon` | | 这条消息的头像，必须是 https；不填用 bot 头像 |
| `allow_queries` | | `true` 时卡片里的 `request()` 可以把查询发给这个 bot；默认 `false` |
| `dry_run` | | `true` 时只校验：不入队、不推送，返回 `{"dry_run":true,"html":清理后的卡片,"input_size","raw_size","compressed_size","removed":[…]}`，即清理后卡片的大小（上限 32768 和 4096）和白名单删掉的内容（如 `"onclick on <div>"`、`"<iframe>"`）。计入限流 |
| `open` | | `chat`（默认）或 `url`：`url` 表示点通知直接打开消息的 `url`，不进会话（要同时给 `url`） |
| `image` | | https 图片，最多 2048 字符：附在通知上，会话气泡里也显示。设备自己下载（≤ 5 MB，10 秒超时） |
| `ttl` | | 秒，60 到 `HONK_MESSAGE_TTL`：消息在队列里保留多久，同时写进 APNs 的 `apns-expiration` 和 FCM 的 `ttl` |
| `silent` | | `true`：不弹通知，也不进通知中心；只进会话、未读数和角标，走静默推送 |
| `parse_mode` | | `Markdown`：正文按 Markdown 渲染（`**粗体**`、`*斜体*`、`` `行内代码` ``、代码块、`[文字](https://…)` 链接、`-` 和 `1.` 列表）；横幅显示去掉标记的纯文本 |

没带 `parse_mode` 时，正文里的 `https://` 链接可以点。通知上有 `copy` 时带「复制」，有 `url` 时带「打开链接」，总有「标为已读」。

```bash
curl https://honk.example.com/bot$TOKEN/sendMessage \
  -d title="部署成功" -d body="sub2api / sluice 已上线" -d id=dep-42 \
  --data-urlencode 'html=<div><b>{{status}}</b></div>' -d 'data={"status":"已上线"}'
```

### editMessageData

修改卡片数据，不弹新通知。用 `message_id` 或 `id` 指定是哪条消息，`data` 是新数据（加密的 bot 改发 `ciphertext`，明文是 `{"data":"…"}`）。

### deleteMessage

删除消息，并撤回已经显示的系统通知。用 `message_id` 或 `id` 指定。

### getMe

返回这个 bot 的信息，可以用来测试 token 是否有效。

### 卡片回调：setWebhook、getUpdates、answerWidgetQuery

用 `allow_queries=true` 发出的卡片，可以在点击处理函数里调 `request(data)`（1–64 字节）。App 把它发给网关，网关把它作为更新 `{"update_id":N,"widget_query":{"id","message_id","data"}}` 交给 bot，并把 App 的请求挂住最多 15 秒。字段名和 Telegram 的 `WidgetQuery`、`answerWidgetQuery` 一致。bot 用下面两种方式之一收更新，不能同时用：

- `setWebhook`：`url`（只能是 https；`url` 为空表示删除）和可选的 `secret_token`（会放在请求头 `X-Honk-Bot-Api-Secret-Token` 里带回来）。网关把更新以 JSON POST 过去，5 秒超时，不跟随重定向。解析后落在回环、内网、链路本地等内部地址的主机会被拒绝（设置时检查一次，每次连接前再检查一次），除非设了 `HONK_WEBHOOK_ALLOW_PRIVATE=true`。`deleteWebhook` 删除；`getWebhookInfo` 返回 `url`、`has_custom_certificate`、`pending_update_count`。
- `getUpdates`：`offset`、`limit`（1–100）、`timeout`（0–50 秒，长轮询）。更新只放在内存里，15 秒后丢弃；小于 `offset` 的更新视为已确认并丢掉。设了 webhook 时返回 `409 Conflict`。

`answerWidgetQuery`：`widget_query_id` 和 `data`（0–1024 字节），要在 15 秒内调。答案只回给发起请求的那台设备；已超时、已回答过或属于别的 bot 的 query 返回 `400`。

### 旧 token

短 bot id 之前的网关（数据库 schema v1）用自增整数做 bot id，token 形如 `4:Gw2K7mx…`。升级后每个 bot 都会分到一个短 id；旧 token 在重置之前照常可用，重置后的新 token 以短 id 开头。App 第一次同步时会用本机存的 token 调 `getMe` 查出对应的短 id（没有 token 就按创建时间和名称匹配），把这个 bot 的本地消息和设置迁移过去；连不上网关时保留这个 bot，下次再试。先更新 App 再升级网关：旧版 App 读不了短 id（`/v1/info` 的 `api` 是 2），新版 App 连旧网关也能用。

### 卡片 HTML

网关只保留白名单里的元素，其他元素连同子元素一起删掉：

- 文本和结构：`div`、`span`、`p`、`h1`–`h6`、列表、`table`、`details`、`pre`、`code`
- 交互：`button`、`a`
- 样式：`style`
- 图片：`img`（只接受 `data:` 图片）
- 内联 SVG
- 内联 `<script>`（profile 2，见下面「卡片脚本」）

以下内容会被删除：

- 带 `src` 或 `type` 不是 JavaScript 的脚本（包括 module）、`on*` 事件属性、表单控件
- 外部链接；`a` 只允许 `https://`、`#id` 或 `{{key}}`
- CSS 里引用外部资源的写法：`@import`、`expression()`、非 data: 的 `url()`
- SVG 属性值里不是 `url(#id)` 的 `url()`，以及带 CSS 转义（`\`）的值

渲染时客户端还会再按自己的 CSS 白名单过滤一遍。

App 把内联 SVG（`svg`、`g`、各种图形、`text`/`tspan`、渐变、`symbol`/`use`）画成图片：把清理过的子树重新写成 SVG 标记，只保留白名单里的元素和属性、卡片内的 `use` 引用（`#id`）和 `url(#id)` 填充，再栅格化。尺寸先看 CSS，再看 `width`、`height` 属性（`width="100%"` 占满卡片宽度，`height` 按 px），都没有时按 `viewBox` 的宽高比；`preserveAspectRatio`（包括 `none`）决定怎么填满这个框。`{{key}}`、`var()` 和 `currentColor` 在绘制前替换好；`<style>` 规则管不到 SVG 内部，所以 SVG 里的元素要用属性或固定颜色。`<title>` 或 `aria-label` 作为无障碍标签。旧版 App 会跳过内联 SVG。

### 卡片样式

除了 `style=""`，卡片也可以像 Telegram widget 那样写 `<style>`：

- 选择器：标签、`.class`、`#id`、属性选择器，组合写法（`div.card`），后代、子元素（`>`）和兄弟（`+`、`~`）组合符，`:first-child`、`:last-child`、`:nth-child()`，`:root`（`html`、`body` 也指它），一条规则可以写多个选择器
- 层叠：按优先级和先后顺序；内联 `style` 优先，除非规则写了 `!important`
- 变量：`:root` 或任意元素上的 `--x`，用 `var()` 读取；主题变量 `--tg-theme-*`
- 深色模式：`@media (prefers-color-scheme: dark)` 和 `light-dark()` 跟随 App 的外观
- `display: none` 隐藏元素；`<style>` 和 `class` 里也可以用 `{{key}}`

只生效前 400 条规则；其他媒体查询、`@keyframes`、伪元素和 `:hover` 会被忽略。

### 卡片脚本（profile 2）

卡片可以像 Telegram HTML widget 那样带内联脚本。iOS 和 Android App 给每张卡片开一个独立的 QuickJS 运行时（[quickjs-ng](https://github.com/quickjs-ng/quickjs)，代码在 `native/`），在后台线程上跑，不能联网、不能读写文件，内存 8 MB，每个任务 200 毫秒；超出就停止，卡片保留最后画出的样子。

- `window.TelegramWidget`：`chatData`（消息的 `data`）、`themeParams`、`colorScheme`；`onEvent('themeChanged' | 'activated' | 'deactivated', …)`；在点击处理函数里调用 `openLink(url)`、`copyText(text)`
- 精简 DOM：`getElementById`、`querySelector`、`textContent`、`innerHTML`、`classList`、`style`、`dataset`、`createElement`、`addEventListener('click', …)`
- 定时器，以及 4 KB 的 `localStorage`

脚本画出来的内容，App 同样按白名单过滤后再显示。消息用 `allow_queries` 发出时，`request(data)`（1–64 字节，只能在点击处理函数里调，每次点击一次）把查询发给 bot，返回的 Promise 以 bot 的答案（最多 1 KB）兑现：App 自己把它发给网关，bot 用 `answerWidgetQuery` 回答（见上面的 Bot API）。否则或出错时以 `WidgetRequestError` 拒绝，`code` 是 `NOT_ALLOWED`（消息不允许查询）、`INVALID_DATA`、`TOO_MANY_REQUESTS`、`TIMEOUT`（15 秒没有答案）、`NETWORK`、`RATE_LIMITED`（每秒超过 1 次）或 `REQUEST_FAILED`。旧版 App 和桌面演示（没有宿主）显示填好 `{{key}}` 的静态卡片，所以关键信息要写在 HTML 里。例子：

```html
<p id="n">{{count}}</p><button id="b">+1</button>
<script>
  let n = Number(JSON.parse(TelegramWidget.chatData).count);
  document.getElementById("b").addEventListener("click", () => {
    document.getElementById("n").textContent = String(++n);
  });
</script>
```

## 命令行

网关的二进制同时是发送端工具。不带参数的 `honk`（或 `honk serve`）和以前一样运行网关；其他子命令以某个 bot 的身份访问网关：

```bash
export HONK_URL=https://honk.example.com HONK_TOKEN=aZ3kQ9xT:Gw2K7mx…
honk send "备份完成" --title 备份 --level passive
make 2>&1 | tail -5 | honk send --title "构建日志"          # 管道输入时，标准输入就是正文
honk send "api v1.8.2 已上线" --html @card.html --data @data.json --id deploy-api
honk edit --id deploy-api --data '{"status":"已回滚"}'
honk delete --id deploy-api
honk me                                                     # token 对应的 bot
honk preview card.html --data data.json --watch             # 每次保存都重发
```

- `HONK_URL` 和 `HONK_TOKEN` 也可以用 `--server` / `--token` 给，或写进 `~/.config/honk/config.json`（`{"url": "…", "token": "…"}`；认 `$XDG_CONFIG_HOME` 和 `$HONK_CONFIG`）。优先级：命令行参数、环境变量、配置文件。
- `send` 的参数：`--title`、`--body`（或直接写在命令后、或走标准输入）、`--html`、`--data`（这两个可写成 `@文件`）、`--id`、`--level`、`--group`、`--link`（即 `url` 参数）、`--copy`、`--icon`、`--dry-run`。
- `preview` 用固定的 `id`（默认 `honk-preview`）和 `level=passive` 发送，手机上那条消息原地更新而且不响。它先做一次 `dry_run`，打印大小和白名单删掉了什么。见[卡片手册](docs/CARDS.zh-CN.md)。
- 退出码：成功 0；网关或网络出错 1（网关返回的 `description` 打到标准错误）；用法错误 2。
- `--key <base64 密钥>`（或 `HONK_KEY`，或配置文件里的 `"key"`）在客户端加密消息内容：title、body、html、data、url、copy、icon 放进一段 AES-256-GCM 密文，以 `ciphertext` 发送，`level`、`group`、`id` 仍是明文。密钥就是 App 在 bot 设置里显示的那一把，见[端到端加密](#端到端加密)。

## 端到端加密

按 bot 打开：Bot 设置里的「端到端加密」。App 生成 32 字节的随机密钥，存在 iOS 与通知扩展共用的钥匙串组，或 Android 的 Keystore 加密偏好里，和 token 并排显示并可复制，同时告诉网关这个 bot 已加密（`PATCH /v1/bots/:id {"encrypted":true}`）。之后网关对这个 bot 的明文 `sendMessage`、`editMessageData` 一律返回 400。发送方需要 token 和密钥。重置密钥会换一把新的，旧的作废，已收到的消息不受影响；关闭加密会删除本机的密钥，bot 又可以发明文。

它让网关运营者、泄露的数据库、推送中继、苹果和谷歌读不到消息内容。它不防发送方被攻破、设备本机被攻破和流量分析：网关仍然知道哪个 bot 在什么时候收到多大的消息，以及仍是明文的 `level`、`group`、`id`、`ttl`、`silent`。加密消息的推送不带标题、正文和 bot 名（横幅在设备上解密后再生成）；解不开的消息（这台设备没有密钥、密钥不对）显示为「无法解密的通知」。

| | |
| --- | --- |
| 参数 | `sendMessage` 的 `ciphertext`，base64url，最大 64 KB。此时 `body` 不必填；旁边再带 `title`、`body`、`html`、`data`、`url`、`copy`、`icon` 会被拒绝 |
| 字节 | 12 字节 nonce，接 AES-256-GCM 密文，再接 16 字节 tag；无填充 base64url |
| 明文 | JSON `{"title","body","html","data","url","copy","icon"}`，字段都是字符串且可省略（`data` 和明文发送一样是 JSON 文本） |
| AAD | bot 的短 id，即 token 里冒号前的部分 |
| 仍是明文 | `level`、`group`、`id`、`ttl`、`silent` |
| 修改 | `editMessageData` 的 `ciphertext`，明文是 `{"data":"…"}` |

网关读不到内容就没法校验，所以 App 解密后再做：卡片原文超过 32 KB 或 zlib 后超过 4 KB、`data` 超过 1 KB 就丢掉卡片（消息保留正文）；标题超过 256、正文超过 4096 个字符会被截断；`url` 不是 http(s)、`icon` 不是 https 会被清空。App 画卡片之前还会用自己的白名单再清理一遍。一个 bot 在本机有密钥之后，发给它的明文同样不被信任，显示为占位消息。

`honk send --key 密钥`（或 `HONK_KEY`）已经做了这些。用代码发送：

Python（`pip install cryptography`）：

```python
# pip install cryptography
import base64, json, os, urllib.request
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

url, token, key = os.environ["HONK_URL"], os.environ["HONK_TOKEN"], os.environ["HONK_KEY"]
b64d = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
b64e = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()

content = {"title": "Deploy", "body": "api v1.8.2 is live", "html": "<b>{{status}}</b>", "data": json.dumps({"status": "live"})}
nonce = os.urandom(12)
# AESGCM returns ciphertext || tag; the bot id (before the ":") is the AAD.
sealed = AESGCM(b64d(key)).encrypt(nonce, json.dumps(content).encode(), token.split(":")[0].encode())
body = {"ciphertext": b64e(nonce + sealed), "level": "active"}

req = urllib.request.Request(f"{url}/bot{token}/sendMessage", json.dumps(body).encode(), {"Content-Type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
```

Node（18 或更新）：

```js
import { createCipheriv, randomBytes } from "node:crypto";

const { HONK_URL: url, HONK_TOKEN: token, HONK_KEY: key } = process.env;

const content = { title: "Deploy", body: "api v1.8.2 is live", html: "<b>{{status}}</b>", data: JSON.stringify({ status: "live" }) };
const nonce = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), nonce);
cipher.setAAD(Buffer.from(token.split(":")[0])); // the bot id (before the ":")
const sealed = Buffer.concat([nonce, cipher.update(JSON.stringify(content)), cipher.final(), cipher.getAuthTag()]);

const res = await fetch(`${url}/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ciphertext: sealed.toString("base64url"), level: "active" }),
});
console.log(await res.text());
```

Go：

```go
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

func main() {
	url, token, keyText := os.Getenv("HONK_URL"), os.Getenv("HONK_TOKEN"), os.Getenv("HONK_KEY")
	key, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(keyText, "="))
	if err != nil || len(key) != 32 {
		panic("HONK_KEY must be 32 bytes of base64url")
	}

	content, _ := json.Marshal(map[string]string{
		"title": "Deploy", "body": "api v1.8.2 is live", "html": "<b>{{status}}</b>", "data": `{"status":"live"}`,
	})
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize()) // 12 bytes
	rand.Read(nonce)
	botID, _, _ := strings.Cut(token, ":")
	// Seal appends ciphertext || tag to the nonce; the bot id is the AAD.
	sealed := gcm.Seal(nonce, nonce, content, []byte(botID))

	body, _ := json.Marshal(map[string]string{"ciphertext": base64.RawURLEncoding.EncodeToString(sealed), "level": "active"})
	res, err := http.Post(url+"/bot"+token+"/sendMessage", "application/json", bytes.NewReader(body))
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	fmt.Println(string(out))
}
```

运行时设好 `HONK_URL`、`HONK_TOKEN` 和 `HONK_KEY`，密钥就是 App 里显示的那一把。修改消息时，加密 `{"data":"…"}`，作为 `ciphertext` 发给 `editMessageData`，再带 `id` 或 `message_id`。

## 接入现有工具

`/bot<token>/hook/<kind>` 接收其他工具的 webhook 并转成消息，用的 token、限流和校验都和 `sendMessage` 一样。把带 token 的这个地址填到工具要求 webhook 地址的地方。没有内容可显示的请求（GitHub 的 `ping`、没有告警的 Alertmanager 分组）返回 `{"ok":true,"result":{"ignored":true}}`，什么也不发。查询串里的 `level`、`group`、`icon`、`copy`、`url`、`title` 会覆盖适配器的选择（`…/hook/github?level=passive`）。

| `kind` | 来源 | 结果 |
| --- | --- | --- |
| `slack` | Slack incoming webhook（`text`、`attachments`、section `blocks`） | 正文取文字；第一个 attachment 的 title 和 `title_link` 作标题和链接；`<url\|label>` 变成 `label` |
| `alertmanager` | Alertmanager `webhook_configs`（version 4） | 标题 `[FIRING:n] 名称`；每条告警一行；`groupKey` 作消息 `id`，所以「恢复」原地替换「触发」；critical 为 `timeSensitive`，恢复为 `passive`；附带状态卡片 |
| `grafana` | Grafana webhook 联系点 | 版式相同；只有一条告警时用它的 `fingerprint` 作 `id`，否则用 `groupKey` |
| `github` | 仓库 webhook（JSON 格式），事件名取自 `X-GitHub-Event` | `workflow_run`（每个 workflow 和分支一条：排队、运行、结束互相替换，失败为 `timeSensitive`）、`release`、`issues`、`pull_request`、`push`；其他事件给一行摘要 |
| `bark` | Bark 客户端发出的请求 | 把 Bark 服务器设成 `https://honk.example.com/bot<token>/hook/bark`；支持 `/<key>/<body>`、`/<key>/<title>/<body>`、`/<key>/<title>/<subtitle>/<body>`（key 被忽略）和 `POST /push`（JSON 或表单：`title`、`subtitle`、`body`、`level`、`group`、`url`、`copy`、`icon`、`id`）；声音、角标之类忽略 |
| `json` | 任意 JSON | 用查询串指定字段取值路径：`?title=$.alert.name&body=$.message&group=ci`。路径写法 `$.a.b`、`$.items[0].name` 或 `$.items.0.name`；不以 `$` 开头的值按字面使用；没有 `body` 时把整段 JSON 当正文 |

GitHub 适配不校验 `X-Hub-Signature-256`：URL 里的 token 就是密钥，别让它出现在公开日志里。在 GitHub Actions 里请直接用本仓库的 action：

```yaml
- uses: evumi/honk@v1
  if: failure()
  with:
    url: ${{ secrets.HONK_URL }}
    token: ${{ secrets.HONK_TOKEN }}
    title: "${{ github.repository }}: 构建失败"
    body: "${{ github.workflow }} on ${{ github.ref_name }}"
    id: ci-${{ github.workflow }}
    level: timeSensitive
```

输入：`token`、`url`（必填），`title`、`body`（不填用标题）、`id`、`level`、`html`、`data`。这是个 composite action，内部用 `curl`，网关拒绝消息时这一步失败。

## App API

除了注册设备，其他接口都需要带 `Authorization: Bearer <device_secret>`。

| 接口 | 说明 |
| --- | --- |
| `GET /v1/info` | `{"name":"honk","version","api":2,"features":[…],"push":{"ios","android"}}`（`features` 有 `link` 表示支持设备组和配对，中继会有 `relay`）（`direct`、`relay` 或 `off`）；设了 `HONK_REGISTER_KEY` 时多一个 `register_key_required` |
| `POST /v1/devices` | `{"platform":"ios"\|"android","push_token":"…","name":"…","register_key":"…"}`（`name` 可选，最长 64 个字符：手机的名称或型号；网关要求口令时才需要带 `register_key`），返回 `device` 和 `device_secret`。每台新设备先自成一个设备组 |
| `GET` / `PUT` / `DELETE /v1/devices/me` | 读取设备信息；更新 push token 和/或 `name`；把这台设备从设备组移除（最后一台时，设备组连同它的 bot 和队列一起删除）。`DELETE /v1/devices/me?all=true` 删除整个设备组：所有设备、bot 和排队的消息（App「删除全部数据」） |
| `GET /v1/devices` | 设备组里的设备：`id`、`name`、`platform`、`seen_at`（Unix 毫秒，最多每小时写一次）、`current` |
| `DELETE /v1/devices/:id` | 移除设备组里的一台设备（不在组内的返回 404） |
| `POST /v1/links` | `{"link_id","bundle"}`：保存一份配对数据（不透明的 base64url，最大 16 KB；`link_id` 是 16 到 64 个 base64url 字符），10 分钟有效，每个设备组同时只有一个，返回 `expires_in` 秒数；`link_id` 已被占用时返回 409 |
| `POST /v1/links/claim` | 新设备发 `{"link_id"}`：把它所在的整个设备组（设备、bot、排队的消息）并入创建配对的设备组，返回 `bundle`。只能用一次；未知、过期或已用过返回 404；合并后超过 bot 上限返回 400；同一 IP 尝试太多返回 429（突发 5 次，之后每小时 10 次） |
| `GET` / `POST /v1/bots` | 列出 bot；创建 bot：`{"name","avatar","default_level"}`，返回 `bot` 和 `token`。`avatar` 是 `preset:<icon>:<#rrggbb>`、https URL，或 `local:<文件名>`：用户在 App 里从相册选的图片，只存在手机上（网关只存这个名字） |
| `GET` / `PATCH` / `DELETE /v1/bots/:id` | 读取、修改、删除一个 bot（`:id` 是 bot 的短 id）。`PATCH` 接受 `name`、`avatar`、`default_level` 和 `encrypted`（`true`：拒绝这个 bot 的明文发送；密钥本身不会到网关） |
| `POST /v1/bots/:id/token` | 重置 token，旧 token 立即失效 |
| `GET /v1/messages/:id` | 拉一条消息；条目可能是 `message`、`edit` 或 `delete` |
| `GET /v1/sync?cursor=&limit=` | 拉 cursor 之后的消息，返回 `messages`、`cursor`、`has_more` |
| `POST /v1/ack` | `{"up_to": <id>}`：告诉网关这台设备已存好这个 id 及之前的消息（设备组里每台设备各有一个水位，只升不降） |

`edit` 和 `delete` 条目用 `target_id` 或 `id` 指向原消息。原消息可能已经从队列删掉了，客户端要对自己本地存的那份执行。
