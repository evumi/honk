# App Store images

Six 6.9" iPhone screenshots (1320×2868) per language; App Store Connect scales them for the other iPhone sizes.

| File | English | 中文 |
| --- | --- | --- |
| `01-channels.png` | Every service gets its own channel. | 每个服务，一个频道 |
| `02-cards.png` | Notifications that say more than one line. | 通知，不止一行字 |
| `03-lockscreen.png` | Know who’s honking at a glance. | 锁屏上，一眼认出是谁 |
| `04-curl.png` | Push from any script with one curl. | 一行 curl，随处推送 |
| `05-dark.png` | Built for the night shift. | 深夜值班，也看得清 |
| `06-self-hosted.png` | Your gateway. Your data. | 网关和数据，都在你手里 |

`en/` goes to the English (U.S.) localization, `zh-Hans/` to Simplified Chinese.

Regenerate after UI or copy changes (macOS with the nsh CLI):

```bash
scripts/brand/capture-screens.sh build/screens-en en-US
scripts/brand/capture-screens.sh build/screens-zh zh-Hans-CN
swift scripts/brand/render.swift build/screens-en build/screens-zh
```

The copy is in `shots` in `scripts/brand/render.swift`. The lock screen is drawn, not captured.
