// The app's languages: Simplified Chinese (the source strings) and English,
// picked from the system locale; anything that is not Chinese gets English.
// Strings are written in Chinese in the code and looked up here, so a missing
// entry shows the Chinese text rather than nothing.
import { locale } from "nsh";

export type Lang = "zh" | "en";

/** The current language (reactive: follows the system locale). */
export function lang(): Lang {
  return locale().toLowerCase().startsWith("zh") ? "zh" : "en";
}

const EN: Record<string, string> = {
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
  "部署成功": "Deployed",
  "sub2api / sluice 已上线": "sub2api / sluice is live",
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
  "切换中…": "Switching…",
  "保存并切换": "Save and switch",
};

/** The string in the current language; `{name}` placeholders are filled from `vars`. */
export function tr(zh: string, vars?: Record<string, string | number>): string {
  let s = lang() === "zh" ? zh : (EN[zh] ?? zh);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
