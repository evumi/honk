// The app's languages: Simplified Chinese (the source strings) and English,
// picked from the system locale; anything that is not Chinese gets English.
// Strings are written in Chinese in the code and looked up here, so a missing
// entry shows the Chinese text rather than nothing.
import { locale, signal, Storage } from "nsh";

export type Lang = "zh" | "en";
/** The language chosen in Settings: the system's, or one of the app's. */
export type LangChoice = "system" | Lang;

const KEY = "honk.language";
const choice = signal<LangChoice>("system");
void Storage.getItem(KEY).then((v) => {
  if (v === "zh" || v === "en") choice.set(v);
}).catch(() => {});

/** The language chosen in Settings (reactive). */
export function langChoice(): LangChoice {
  return choice();
}

/** Switches the app's language and remembers it on the device. */
export async function setLangChoice(c: LangChoice): Promise<void> {
  choice.set(c);
  await (c === "system" ? Storage.removeItem(KEY) : Storage.setItem(KEY, c)).catch(() => {});
}

/** The current language (reactive): the one chosen in Settings, else the system locale's. */
export function lang(): Lang {
  const c = choice();
  if (c !== "system") return c;
  return locale().toLowerCase().startsWith("zh") ? "zh" : "en";
}

const EN: Record<string, string> = {
  "上传图片": "Upload image",
  "无法使用这张图片": "Can't use this image",
  "图片太大，请换一张小一点的": "The image is too large; pick a smaller one",
  "只支持 JPEG、PNG、WebP 和 GIF 图片": "Only JPEG, PNG, WebP and GIF images work",
  // chat list and tabs
  "通知": "Notifications",
  "设置": "Settings",
  "编辑": "Edit",
  "完成": "Done",
  "新建 Bot": "New Bot",
  "搜索": "Search",
  "没有匹配的会话": "No matching chats",
  "还没有 Bot": "No bots yet",
  "每个 Bot 是一个独立的通知渠道。创建后用它的 token 调用发送接口，通知就会出现在这里。":
    "Each bot is its own notification channel. Create one, send to its token, and notifications show up here.",
  "创建第一个 Bot": "Create your first bot",
  "还没有消息": "No messages yet",
  "取消置顶": "Unpin",
  "置顶": "Pin",
  "取消静音": "Unmute",
  "静音": "Mute",
  "标为已读": "Mark as read",
  "取消": "Cancel",
  "删除": "Delete",
  "删除「{name}」？": "Delete “{name}”?",
  "token 立即失效，网关队列里未拉取的消息一并删除。": "Its token stops working at once, and messages still queued on the gateway are deleted.",
  // settings
  "已开启": "On",
  "已关闭": "Off",
  "未设置": "Not set",
  "已注册": "Registered",
  "注册中…": "Registering…",
  "等待推送授权": "Waiting for push",
  "注册失败": "Failed",
  "未注册": "Not registered",
  "推送": "Push",
  "注册失败：{error}。检查网关地址和网络后重试。": "Registration failed: {error}. Check the gateway address and your connection, then try again.",
  "未知错误": "unknown error",
  "模拟器调试：没有 APNs 推送，App 在前台时每 10 秒同步一次。": "Simulator build: no APNs pushes, so the app syncs every 10 seconds while open.",
  "通知被关闭时，消息仍会在打开 App 时同步过来。": "With notifications off, messages still sync when you open the app.",
  "系统通知": "Notifications",
  "设备注册": "Device",
  "正在重试…": "Retrying…",
  "重试注册": "Retry registration",
  "网关": "Gateway",
  "更改": "Change",
  "立即同步": "Sync now",
  // chat
  "还没有消息。用 token 发一条试试。": "No messages yet. Send one with the bot's token.",
  "静音通知": "Mute",
  "Token 与设置": "Token & Settings",
  "返回": "Back",
  "机器人 · 已静音": "bot · muted",
  "机器人": "bot",
  "Bot 设置": "Bot Settings",
  "复制正文": "Copy text",
  "复制内容": "Copy content",
  "打开链接": "Open link",
  "今天": "Today",
  "昨天": "Yesterday",
  // new bot
  "创建失败": "Couldn't create the bot",
  "好": "OK",
  "新 Bot": "New bot",
  "外观": "Appearance",
  "名称": "Name",
  "例如：Berth 部署": "e.g. Deploys",
  "显示在会话列表和锁屏通知上。": "Shown in the chat list and on the lock screen.",
  "默认提醒级别": "Default alert level",
  "静默只进通知中心，不响铃不亮屏；时效性可以穿透专注模式。发送时用 level 参数可以单条覆盖。":
    "Passive goes straight to Notification Center without sound; Time Sensitive breaks through Focus. The level parameter overrides it per message.",
  "创建中…": "Creating…",
  "创建 Bot": "Create Bot",
  "静默": "Passive",
  "普通": "Active",
  "时效性": "Time Sensitive",
  // bot created
  "已复制": "Copied",
  "{name} 已创建": "{name} is ready",
  "用下面的 token 发送通知。token 相当于密码，泄露后可以在设置里重置。": "Send notifications with this token. Treat it like a password; you can reset it in settings.",
  "复制 token": "Copy token",
  "发送示例": "Example",
  "复制示例": "Copy example",
  "进入会话": "Open chat",
  "现在": "now",
  "{n} 条新消息": "{n} new messages",
  "回到最新消息": "Jump to latest",
  "语言": "Language",
  "通用": "General",
  "跟随系统": "System",
  "删除后 token 立即失效，网关队列里未拉取的消息一并删除。": "Deleting a bot revokes its token at once and drops its messages still queued on the gateway.",
  "机器人 · 创建于 {date}": "bot · created {date}",
  "消息": "Messages",
  "接收通知": "Notifications",
  "保存": "Save",
  "保存中…": "Saving…",
  "编辑 Bot": "Edit Bot",
  "保存失败": "Couldn’t save",
  "发送一条测试通知": "Send a test notification",
  "发送中…": "Sending…",
  "已发送，看看通知": "Sent — check your notifications",
  "发送失败，点按重试": "Couldn’t send — tap to retry",
  "测试通知": "Test notification",
  "{name} 已就绪，以后的通知都会出现在这里。": "{name} is ready. Its notifications will show up here.",
  "部署成功": "Deployed",
  "evumi / sluice 已上线": "evumi / sluice is live",
  // bot settings
  "重置 token？": "Reset the token?",
  "旧 token 立即失效，用到它的发送方需要换成新的。": "The old token stops working at once; senders using it need the new one.",
  "重置": "Reset",
  "清空消息？": "Clear messages?",
  "只删除这台设备上的消息。": "Only the messages on this device are deleted.",
  "清空": "Clear",
  "删除这个 Bot？": "Delete this bot?",
  "机器人 · ID {id}": "bot · ID {id}",
  "这台设备上没有保存 token": "No token saved on this device",
  "复制": "Copy",
  "重置 token": "Reset token",
  "置顶会话": "Pin chat",
  "删除后 token 立即失效。": "Deleting a bot revokes its token at once.",
  "清空消息": "Clear messages",
  "删除 Bot": "Delete Bot",
  // delete this device's data
  "数据": "Data",
  "将删除：这台设备在网关上的注册；所有 Bot，它们的 token 立即失效；网关上排队的消息；本机的消息和头像。无法恢复。":
    "This deletes this device's registration on the gateway; all bots, whose tokens stop working at once; the messages queued on the gateway; and the messages and avatars on this phone. It can't be undone.",
  "删除这台设备在网关上的注册、所有 Bot 和排队的消息，并清空本机数据。之后创建 Bot 或重新打开 App 时，这台设备会重新注册。":
    "Deletes this device's registration, all bots and queued messages on the gateway, and clears this phone's data. The device registers again when you create a bot or reopen the app.",
  "正在删除…": "Deleting…",
  "删除失败": "Couldn't delete",
  // device groups
  "设备": "Devices",
  "这台设备": "This device",
  "从未": "never",
  "刚刚": "just now",
  "{n} 小时前": "{n} h ago",
  "{n} 天前": "{n} d ago",
  "添加设备": "Add device",
  "已有设备？输入配对码": "Already have a device? Enter a pairing code",
  "设备组里的手机共用同一批 Bot，每条通知都会推送到所有设备。换新手机时，在新手机上输入旧手机的配对码即可，Bot 的 token 不变。":
    "The phones in a device group share the same bots, and every notification is pushed to all of them. To switch phones, enter the old phone's pairing code on the new one; the bots' tokens stay the same.",
  "删除全部数据": "Delete all data",
  "删除全部数据？": "Delete all data?",
  "将删除：设备组里所有设备在网关上的注册（包括其他 {n} 台设备）；所有 Bot，它们的 token 立即失效；网关上排队的消息；本机的消息和头像。无法恢复。":
    "This deletes the registration of every device in the group on the gateway ({n} other devices included); all bots, whose tokens stop working at once; the messages queued on the gateway; and the messages and avatars on this phone. It can't be undone.",
  "从设备组移除这台设备": "Remove this device from the group",
  "从设备组移除这台设备？": "Remove this device from the group?",
  "这台设备会从设备组里退出，并清空本机的消息、头像和 token。其他设备和 Bot 不受影响，Bot 仍会推送给它们。之后可以用配对码重新加入。":
    "This phone leaves the group, and its messages, avatars and tokens are cleared. The other devices and the bots are not affected; the bots keep pushing to them. You can join again with a pairing code.",
  "移除": "Remove",
  "移除 {name}？": "Remove {name}?",
  "这台设备不再收到通知，也不再能使用这些 Bot。Bot 和其他设备不受影响。":
    "This device stops getting notifications and can no longer use these bots. The bots and the other devices are not affected.",
  "「从设备组移除这台设备」只让这台手机退出，Bot 留给其他设备。「删除全部数据」会删除设备组在网关上的一切，并清空本机。":
    "\"Remove this device from the group\" only takes this phone out; the bots stay with the other devices. \"Delete all data\" deletes everything of the group on the gateway and clears this phone.",
  "正在生成…": "Generating…",
  "复制配对码": "Copy pairing code",
  "重新生成": "Generate a new one",
  "配对码已过期": "The pairing code has expired",
  "{time} 后过期，只能用一次": "Expires in {time}; works once",
  "在新手机上打开 Honk，到「设置 → 设备 → 已有设备？输入配对码」，输入这串配对码。新手机加入后会和这台手机共用所有 Bot，每条通知都会推送到两台手机。":
    "On the new phone, open Honk, go to Settings → Devices → Already have a device? Enter a pairing code, and type this code. The new phone then shares all bots with this one, and every notification is pushed to both.",
  "配对码只经过网关一次，网关看不到它：它只存放用配对码加密过的数据。无论谁拿到配对码，都能在有效期内加入你的设备组，请只给你自己的手机。":
    "The gateway never sees the code: it only holds data encrypted with it. Anyone who has the code can join your device group while it is valid, so give it only to your own phone.",
  "输入配对码": "Enter pairing code",
  "配对码": "Pairing code",
  "粘贴": "Paste",
  "加入": "Join",
  "正在加入…": "Joining…",
  "在已有设备上打开「设置 → 设备 → 添加设备」，会显示 26 位配对码。大小写和短横线都不影响。":
    "On a device you already have, open Settings → Devices → Add device to see a 26-character code. Case and dashes don't matter.",
  "已加入设备组": "Joined the device group",
  "这台手机现在和你的其他设备共用同一批 Bot。你在新手机上原有的 Bot 也并入了设备组。":
    "This phone now shares its bots with your other devices. Any bots this phone already had joined the group too.",
  "{error}。这台设备的数据没有改动，请稍后重试。": "{error}. This device's data is unchanged; try again later.",
  // gateway
  "切换网关？": "Switch gateway?",
  "改用 {url}。这台设备会在新网关上重新注册，当前的 Bot 和消息会从这台设备上清除；它们在原网关上仍然保留。":
    "Use {url}. This device registers again there, and its bots and messages are cleared from this device; they stay on the old gateway.",
  "切换": "Switch",
  "切换失败": "Couldn't switch",
  "正在连接…": "Connecting…",
  "连接正常 · 网关版本 {version}": "Connected · gateway {version}",
  "未知": "unknown",
  "无法连接": "Can't connect",
  "网关地址": "Gateway address",
  "自己部署了 Honk 网关时，填它的地址，例如 https://honk.example.com/。只填域名时默认使用 https。":
    "If you run your own Honk gateway, enter its address, e.g. https://honk.example.com/. A bare domain uses https.",
  "测试连接": "Test connection",
  "当前": "Current",
  "切换后这台设备会在新网关上重新注册，本机的 Bot 和消息会被清除。": "Switching registers this device again and clears its bots and messages.",
  "自定义": "Custom",
  "默认": "Default",
  "恢复默认网关": "Restore default gateway",
  "注册口令": "Register key",
  "可选": "Optional",
  "需要注册口令": "needs a register key",
  "直连": "direct",
  "经中继": "via relay",
  "关闭": "off",
  "iOS 推送：{mode}": "iOS push: {mode}",
  "Android 推送：{mode}": "Android push: {mode}",
  "推送关闭的平台，只能在打开 App 时收到通知。": "On a platform with push off, notifications arrive only when the app is opened.",
  "网关设置了注册口令（HONK_REGISTER_KEY）时，填在这里，注册这台设备时会带上；没有就留空。":
    "If the gateway is set up with a register key (HONK_REGISTER_KEY), enter it here; it is sent when this device registers. Leave it empty otherwise.",
  "切换中…": "Switching…",
  "保存并切换": "Save and switch",
};

/** The string in the current language; `{name}` placeholders are filled from `vars`. */
export function tr(zh: string, vars?: Record<string, string | number>): string {
  let s = lang() === "zh" ? zh : (EN[zh] ?? zh);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
