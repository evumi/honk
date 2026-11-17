# App Store 宣传图

`iphone-6.9/` 是 6.9 英寸 iPhone 的截图，尺寸 1320×2868，App Store Connect 用这一组即可，其他 iPhone 尺寸由 Apple 自动缩放。

| 文件 | 标题 |
| --- | --- |
| `01-channels.png` | 每个服务，一个频道 |
| `02-cards.png` | 通知不止一行字 |
| `03-lockscreen.png` | 锁屏上就认得出是谁 |
| `04-curl.png` | 一行 curl 就能推送 |
| `05-dark.png` | 深夜值班也看得清 |

界面变了以后重新生成（需要 macOS 和 nsh CLI）：

```bash
scripts/brand/capture-screens.sh build/screens   # 用演示数据截 App 界面（440×956）
swift scripts/brand/render.swift build/screens   # 合成宣传图，同时更新 logo 和 App 图标
```

标题和副标题写在 `scripts/brand/render.swift` 的 `slides` 里。锁屏那张是直接画的，不是截图。
