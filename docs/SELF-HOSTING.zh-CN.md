# 自己部署 Honk 网关

[English](SELF-HOSTING.md)

网关是一个 Go 二进制加一个 SQLite 文件。Honk App 只和它的网关通信，所以可以把 App 指到你自己的网关（设置 → 网关），bot、token 和消息队列都留在自己的机器上。本文说明：用 Docker Compose 运行、在前面放 HTTPS、推送怎么送到手机、备份和升级。

## 1. 准备

- 一台装了 Docker 的主机，和一个指向它的域名，例如 `honk.example.com`；80 和 443 端口要能从外面访问（申请证书要用）。
- 从 App Store 或 Google Play 安装的 Honk App。**不需要** Apple 或 Google 的凭据，见「推送和中继」。

## 2. Docker Compose

新建目录，写 `docker-compose.yml`：

```yaml
services:
  honk:
    image: ghcr.io/evumi/honk-gateway:latest   # 用起来稳定后固定成某个版本，例如 :0.2.0
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"                  # 只有反向代理能访问
    volumes:
      - honk-data:/data                        # SQLite 数据库
    environment:
      HONK_MESSAGE_TTL: 168h
      # HONK_REGISTER_KEY: 换成一串足够长的随机字符   # 只有知道它的设备才能注册
      # HONK_LOG_FORMAT: json
volumes:
  honk-data:
```

```bash
docker compose up -d
docker compose logs honk      # 日志里写明每个平台怎么推送
curl http://127.0.0.1:8080/v1/info
```

`/healthz` 返回 `ok`，镜像带健康检查。仓库里的 `gateway/docker-compose.yml` 是给自己有 APNs 和 FCM 凭据的网关用的（第 6 节）。

## 3. 反向代理和 TLS

App 要求 HTTPS。Caddy 会自己申请和续期证书，`Caddyfile`：

```
honk.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

也可以作为同一个 compose 文件里的另一个服务：

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
```

（这时 Caddyfile 里写 `reverse_proxy honk:8080`，`honk` 服务去掉 `ports`，`volumes` 里加上 `caddy-data`。）用 nginx 的话，转发到 `127.0.0.1:8080`，并传 `X-Forwarded-For` 或 `X-Real-IP`：网关靠它们得到客户端地址来做注册限流，代理不传的话所有客户端看起来是同一个地址。请求体都很小，超时不用特别设置。

然后在 App 里：设置 → 网关，填 `https://honk.example.com/`，点「测试连接」再保存。App 会在你的网关上注册这台设备（设了注册口令就带上）。切换网关会清掉手机上的 bot 和消息；它们仍留在原来的网关上。

## 4. 推送和中继

APNs 和 FCM 只投递用已安装 App 的凭据签名的推送，你的网关没有这些凭据，所以用**推送中继**：每条推送变成一次对中继的 HTTP 请求，默认是官方网关 `https://honk.bunship.site/`，中继把它交给 Apple 或 Google，再把结果告诉你的网关。其他都不变：App 只和你的网关打交道，队列和每条消息都在你的网关里。

中继能看到什么（也就是 Apple 和 Google 通过它能看到什么）：

- 看到：push token 和平台、消息 id、bot id、通知级别、发送方 `id` 的哈希、你的网关的 IP 和请求时间。这些都不按条保存；中继只保存它代发的网关的表（id、key 的哈希、时间）和内存里的限流计数。
- 默认看不到：bot 名称、标题、正文、group、卡片、data 和发送方的 `id`。推送显示“新通知”，等 App 从你的网关拉到消息后换成真实文字。

设 `HONK_PUSH_CONTENT=full` 可以让中继推送也带上 bot 名称、标题和正文（它们会像在官方网关上一样经过中继、Apple 和 Google）。设 `HONK_RELAY_URL=off` 关闭中继：没有凭据的平台就收不到推送，消息只在打开 App 时出现（网关页会提示）。`HONK_RELAY_URL` 也可以指向你信任的另一个中继，或者你自己的（第 6 节）。

启动日志写得很明白：

```
level=WARN msg="no push credentials for ios: pushes go through the relay https://honk.bunship.site (push token, message id and bot id pass through it; banner text does not); set HONK_APNS_KEY_FILE to push directly or HONK_RELAY_URL=off to turn this off" platform=ios
```

中继是免费的便利服务；网关滥用（大量发往失效 token）时会被拒绝，限流规则由运营方定。见[隐私政策](../PRIVACY.md)。

## 5. 备份

数据都在 SQLite 文件里（`/data/honk.db`，WAL 模式），它是短期队列：消息 `HONK_MESSAGE_TTL` 后过期。丢了会损失的是设备注册、bot 和它们的 token。网关运行时不要用 `cp` 复制文件，用 SQLite 的在线备份，得到一致的副本：

```bash
mkdir -p backup
docker run --rm -v honk_honk-data:/data -v "$PWD/backup:/backup" keinos/sqlite3 \
  sqlite3 /data/honk.db ".backup '/backup/honk-$(date +%F).db'"
```

（卷名是 `<项目名>_honk-data`，用 `docker volume ls` 查。）放进 cron，保留几份。要持续复制可以用 [Litestream](https://litestream.io/)：作为第二个容器挂同一个 `/data` 卷，运行 `litestream replicate /data/honk.db s3://bucket/honk`，用 `litestream restore` 恢复。恢复 `.backup` 副本时先停网关，把文件放到 `/data/honk.db`（删掉 `honk.db-wal` 和 `honk.db-shm`）。

## 6. 自己的凭据，以及提供中继

如果你自己构建 App（自己的 bundle id、Apple 团队和 Firebase 项目），给网关配上凭据，它就直接推送，默认带完整文字：

```yaml
    volumes:
      - honk-data:/data
      - ./secrets:/secrets:ro            # apns.p8、fcm.json
    environment:
      HONK_APNS_KEY_FILE: /secrets/apns.p8
      HONK_APNS_KEY_ID: ABC123DEFG
      HONK_APNS_TEAM_ID: ABCDE12345
      HONK_APNS_TOPIC: com.example.honk   # 你的 bundle id
      HONK_FCM_CREDENTIALS_FILE: /secrets/fcm.json
```

两个平台互相独立：只配 FCM 文件时，Android 直连，iOS 走中继。有凭据的网关也可以用 `HONK_RELAY_SERVE=true` 给别人当中继（限流：`HONK_RELAY_RATE`、`HONK_RELAY_BURST`、`HONK_RELAY_TOKEN_PER_MINUTE`）；至少一个平台有凭据才能启动。它只用自己的凭据发送，从不转给别的中继；提供中继的网关自己也不使用中继。行为不当的网关可以封禁：`sqlite3 honk.db "UPDATE relays SET blocked = 1 WHERE id = '…'"`，降速时日志里会写出是哪个网关。

## 7. 升级

先升级 App，再升级网关。新 App 能连旧网关（读 `/v1/info` 的 `features`，缺了就回退），但 API 变了的话旧 App 连新网关可能出错。网关启动时迁移数据库（`PRAGMA user_version`，每步一个事务），没有自动回退的办法：升级前先备份（第 5 节）。

```bash
docker compose pull && docker compose up -d
docker compose logs --tail 20 honk
```

打开了 `/metrics` 的话（容器内 `HONK_METRICS_ADDR=0.0.0.0:9100`，只发布在内网接口）可以看 `honk_pushes_total` 按 route 和 result 的数字，确认推送正常。

## 8. 配置项

所有配置都是环境变量，表格见 [README](../README.zh-CN.md#运行网关)。自建通常会用到：`HONK_REGISTER_KEY`（防止陌生人注册）、`HONK_MESSAGE_TTL`、`HONK_RELAY_URL`、`HONK_PUSH_CONTENT`、`HONK_LOG_FORMAT`。
