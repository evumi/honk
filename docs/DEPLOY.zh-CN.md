# 部署与发布

推一个 `v*` 标签（例如 `v0.1.0`）会同时触发三条发布流水线：

| 流水线 | 文件 | 产物 |
| --- | --- | --- |
| 网关镜像 | `.github/workflows/gateway-image.yml` | `ghcr.io/evumi/honk-gateway`（amd64 + arm64）。另外：推到 main 时打 `:main`，可选通过 SSH 自动部署 |
| iOS | `.github/workflows/ios-release.yml` | 用 [asc](https://github.com/rorkai/App-Store-Connect-CLI) 归档、签名并上传 TestFlight；IPA 也作为构建产物保留 14 天 |
| Android | `.github/workflows/android-release.yml` | 签名的 release APK，附在 GitHub Release 上供下载 |

三条流水线都可以在 Actions 页面手动运行（workflow_dispatch）。`ci.yml` 在 PR 上跑网关、HonkKit 和 nsh App 的测试。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

版本号以标签为准，仓库里的版本号不用手改：

| 产物 | 版本 | 构建号 |
| --- | --- | --- |
| 网关镜像 | `:0.1.0`、`:0.1`、`:latest`；`/v1/info` 返回 `0.1.0` | 无 |
| iOS | `MARKETING_VERSION = 0.1.0` | App Store Connect 里这个版本的下一个可用构建号 |
| Android | `versionName = 0.1.0` | 这次 Actions 运行的序号 |

App 设置页底部会显示 `Honk 0.1.0 (构建号)`。

iOS 和 Android 流水线第一步会检查 secrets，缺了就直接失败，并列出缺少哪几项。补齐后在 Actions 页面对这次运行点 Re-run failed jobs，会用同一个标签重新构建，不用打新标签。

## 1. 要填的 Secrets 和 Variables

在仓库 **Settings → Secrets and variables → Actions** 里填写。Secrets 是加密的，Variables 是明文。

### iOS（ios-release.yml）

| 名称 | 类型 | 必填 | 内容 |
| --- | --- | --- | --- |
| `ASC_KEY_ID` | Secret | 是 | App Store Connect API key 的 Key ID |
| `ASC_ISSUER_ID` | Secret | 是 | Issuer ID（在 API key 页面顶部） |
| `ASC_PRIVATE_KEY_B64` | Secret | 是 | `AuthKey_XXXX.p8` 的 base64：`base64 -i AuthKey_XXXX.p8 \| pbcopy` |
| `ASC_APP_ID` | Secret | 是 | App Store Connect 里 App 的数字 ID（App 信息 → Apple ID） |
| `IOS_TEAM_ID` | Secret | 是 | 开发者团队 ID（10 位） |
| `IOS_DIST_P12_B64` | Secret | 是 | Apple Distribution 证书（带私钥）导出的 `.p12` 的 base64 |
| `IOS_DIST_P12_PASSWORD` | Secret | 是 | 导出 `.p12` 时设的密码 |
| `HONK_GATEWAY_URL` | Variable | 是 | App 连接的网关地址，例如 `https://honk.example.com/` |
| `TESTFLIGHT_GROUP` | Variable | 否 | 要分发的 TestFlight 组名或 ID；不填就只上传 |
| `IOS_BUNDLE_ID` | Variable | 否 | 默认 `dev.evumi.honk` |
| `IOS_APP_GROUP` | Variable | 否 | 默认 `group.dev.evumi.honk` |
| `IOS_KEYCHAIN_GROUP` | Variable | 否 | 默认 `dev.evumi.honk.shared`，不含团队前缀 |

API key 在 [App Store Connect → 用户和访问 → 集成](https://appstoreconnect.apple.com/access/integrations/api) 创建，角色选 **App Manager**（流水线要读写描述文件、上传构建）。

### Android（android-release.yml）

| 名称 | 类型 | 必填 | 内容 |
| --- | --- | --- | --- |
| `ANDROID_KEYSTORE_B64` | Secret | 是 | release keystore 的 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | 是 | keystore 密码 |
| `ANDROID_KEY_ALIAS` | Secret | 是 | key 别名 |
| `ANDROID_KEY_PASSWORD` | Secret | 是 | key 密码 |
| `ANDROID_GOOGLE_SERVICES_JSON_B64` | Secret | 是 | Firebase 控制台下载的 `google-services.json` 的 base64 |
| `HONK_GATEWAY_URL` | Variable | 是 | 和 iOS 共用 |

生成 keystore（只做一次，**妥善备份**；丢了就无法给已安装的用户发更新）：

```bash
keytool -genkeypair -v -keystore honk-release.keystore -alias honk -keyalg RSA -keysize 4096 -validity 10000
```

```bash
base64 -i honk-release.keystore | pbcopy
```

### 网关自动部署（gateway-image.yml，可选）

镜像推到 GHCR 用的是 Actions 自带的 `GITHUB_TOKEN`，不用额外配置。想让打标签后自动更新服务器，再填下面这些；`GATEWAY_DEPLOY_HOST` 不填时跳过部署这一步。

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `GATEWAY_DEPLOY_HOST` | Variable | 服务器地址 |
| `GATEWAY_DEPLOY_USER` | Variable | SSH 用户，默认 `deploy` |
| `GATEWAY_DEPLOY_PATH` | Variable | 服务器上 `docker-compose.yml` 所在目录，默认 `/opt/honk` |
| `GATEWAY_SSH_KEY` | Secret | 该用户的 SSH 私钥 |

## 2. 部署网关

需要一台装了 Docker 的服务器和一个指向它的域名。

1. 仓库是私有的，镜像也是私有的。在服务器上登录 GHCR，用一个只有 `read:packages` 权限的 Personal Access Token：

   ```bash
   echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub 用户名> --password-stdin
   ```

2. 放好文件，目录就是 `GATEWAY_DEPLOY_PATH`：

   ```
   /opt/honk/
   ├── docker-compose.yml   ← gateway/docker-compose.yml
   ├── .env                 ← 照 gateway/.env.example 填
   └── secrets/
       ├── apns.p8          ← APNs auth key（Certificates, Identifiers & Profiles → Keys，勾选 APNs）
       └── fcm.json         ← Firebase 项目设置 → 服务账号 → 生成新的私钥
   ```

3. 启动：

   ```bash
   cd /opt/honk && docker compose up -d && curl -s localhost:8080/healthz
   ```

4. 配 HTTPS。compose 只把 8080 端口暴露在 127.0.0.1，需要在前面加一层反向代理。用 Caddy 的话，`/etc/caddy/Caddyfile` 写：

   ```
   honk.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

数据在 Docker volume `honk-data`（SQLite）里，备份这个 volume 即可。消息只是短期队列，丢了影响不大；设备和 bot 的记录丢了，用户需要在 App 里重新创建 bot。

`HONK_APNS_SANDBOX`：TestFlight 和 App Store 的构建用生产环境（`false`）；从 Xcode 直接装到手机上的调试构建用 sandbox（`true`）。一个网关实例只能连其中一个环境。

## 3. 首次发布 iOS 前在 Apple 后台做的事

1. **注册 App ID**：在 Certificates, Identifiers & Profiles 注册 `dev.evumi.honk` 和 `dev.evumi.honk.NotificationService`。
2. **打开 capabilities**：
   - 主 App：Push Notifications、App Groups（`group.dev.evumi.honk`）、Communication Notifications、Time Sensitive Notifications
   - 扩展：App Groups
3. **准备证书**：创建一张 Apple Distribution 证书，导出带私钥的 `.p12`，填进 `IOS_DIST_P12_B64`。
4. **创建 App**：在 App Store Connect 新建 App，记下 Apple ID，填进 `ASC_APP_ID`。
5. **创建 TestFlight 组（可选）**：创建一个内部测试组，填进 `TESTFLIGHT_GROUP`。

描述文件不用手动做：流水线会用 `asc signing fetch --create-missing` 拉取或创建 App Store 描述文件。

## 4. 下载 Android APK

在仓库的 **Releases** 页面下载 `Honk-<版本>-<构建号>.apk`，旁边有它的 sha256。

- **手动运行**：会生成一个 `android-build-<序号>` 的 pre-release。
- **私有仓库**：Release 只有有权限的人能下载。要公开分发，可以把仓库设成公开，或者另建一个公开仓库专门放 Release。

## 5. 尚未验证

这三条发布流水线都还没在 GitHub 上真正跑过：需要先填好上面的 secrets，iOS 那条还要先完成第 3 节的后台准备。第一次运行可能要根据 asc 的实际输出调整参数（例如 `asc signing fetch` 的 JSON 字段名）。

Android 流水线依赖 `android/` 工程（PR evumi/honk#3），合并之前运行会直接报"缺少 gradlew"。流水线会下载 v0.5.1 的 nsh Android 库，并装上同版本的 nsh CLI 把 `app/` 打进 APK；升级 nsh 时两处版本要一起改。
