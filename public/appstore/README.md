# App Store images

Six 6.9" iPhone screenshots (1320×2868) per language; App Store Connect scales them for the other iPhone sizes.

**iPad screenshots are now needed.** The app runs on iPad (`TARGETED_DEVICE_FAMILY` is `1,2` in `ios/project.yml`), so App Store Connect asks for 13" iPad screenshots (2064×2752 portrait) too and scales them for the smaller iPads. They are not generated yet, and `scripts/brand/` captures iPhone screens only. The app keeps its content at most 600 points wide and centred, so an iPad screenshot shows that column on the page background.

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

The copy is in `shots` in `scripts/brand/render.swift`. It writes these images and the iOS app icon as RGB PNGs: App Store Connect rejects ones with an alpha channel (`alpha_channel`), even fully opaque. `scripts/check-app-store-assets.sh` checks that (CI runs it); the other brand PNGs keep their transparency. The lock screen is drawn, not captured.
