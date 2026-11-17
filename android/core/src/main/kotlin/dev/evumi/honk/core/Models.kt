package dev.evumi.honk.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** A notification channel. */
@Serializable
data class Bot(
    val id: Long,
    val name: String,
    val avatar: String = "",
    @SerialName("default_level") val defaultLevel: String = "active",
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("updated_at") val updatedAt: Long = 0,
)

/** One item from the gateway's queue: a new message, or an edit or delete of one. */
@Serializable
data class QueuedMessage(
    @SerialName("message_id") val id: Long,
    @SerialName("bot_id") val botId: Long,
    val kind: Kind = Kind.MESSAGE,
    /** For an edit or delete: the message it applies to (0 when only [collapseId] names it). */
    @SerialName("target_id") val targetId: Long = 0,
    val title: String = "",
    val body: String = "",
    val html: String = "",
    val data: String = "",
    val level: String = "",
    val group: String = "",
    val url: String = "",
    val copy: String = "",
    val icon: String = "",
    /** The sender's replaceable id (`id` in the bot API). */
    @SerialName("id") val collapseId: String = "",
    /** Unix milliseconds. */
    val date: Long = 0,
) {
    @Serializable
    enum class Kind {
        @SerialName("message") MESSAGE,
        @SerialName("edit") EDIT,
        @SerialName("delete") DELETE;

        companion object {
            fun of(s: String?): Kind? = when (s) {
                "message" -> MESSAGE
                "edit" -> EDIT
                "delete" -> DELETE
                else -> null
            }
        }
    }
}

/** A message as kept on the device. */
data class StoredMessage(
    val id: Long,
    val botId: Long,
    val title: String,
    val body: String,
    val html: String,
    val data: String,
    val level: String,
    val group: String,
    val url: String,
    val copy: String,
    val icon: String,
    val collapseId: String,
    val date: Long,
    val read: Boolean,
)

/** One row of the chat list: a bot with its latest message and unread count. */
data class ChatSummary(
    val bot: Bot,
    val muted: Boolean,
    val pinned: Boolean,
    val last: StoredMessage?,
    val unread: Int,
)

/** What applying a queued item changed. */
data class ApplyResult(
    /** The message the item created or changed, if it is still stored. */
    val message: StoredMessage? = null,
    /** Delivered notifications that no longer have a message: remove them. */
    val staleNotificationIds: List<String> = emptyList(),
)

/** A registered device as the gateway reports it. */
@Serializable
data class DeviceInfo(
    val id: String,
    val platform: String = "",
    @SerialName("push_ok") val pushOk: Boolean = false,
)

/** The device's id and secret from registration, and the push token last sent. */
@Serializable
data class Credentials(
    val deviceId: String,
    val secret: String,
    val pushToken: String,
)

/**
 * The fields of an FCM data message (gateway/internal/push/fcm.go). FCM data
 * values are all strings.
 */
data class PushInfo(
    val kind: QueuedMessage.Kind,
    val messageId: Long,
    val botId: Long,
    val targetId: Long = 0,
    val collapseId: String = "",
    val botName: String = "",
    val title: String = "",
    val body: String = "",
    val group: String = "",
    val level: String = "",
) {
    companion object {
        fun parse(data: Map<String, String>): PushInfo? {
            val kind = QueuedMessage.Kind.of(data["kind"]) ?: return null
            val id = data["msg_id"]?.toLongOrNull() ?: return null
            val bot = data["bot_id"]?.toLongOrNull() ?: return null
            return PushInfo(
                kind = kind,
                messageId = id,
                botId = bot,
                targetId = data["target_id"]?.toLongOrNull() ?: 0,
                collapseId = data["id"].orEmpty(),
                botName = data["bot_name"].orEmpty(),
                title = data["title"].orEmpty(),
                body = data["body"].orEmpty(),
                group = data["group"].orEmpty(),
                level = data["level"].orEmpty(),
            )
        }
    }
}
