package dev.evumi.honk.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/** Bot ids: short random strings (`aZ3kQ9xT`). Gateways before v2 sent integers. */
object BotIds {
    /** Whether [id] is an integer id from a gateway or store before short ids. */
    fun isLegacy(id: String): Boolean = id.isNotEmpty() && id.all { it in '0'..'9' }
}

/** Reads a bot id that may be a JSON string or, from an older gateway, a number. */
object BotIdSerializer : KSerializer<String> {
    override val descriptor = PrimitiveSerialDescriptor("BotId", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(value)
    override fun deserialize(decoder: Decoder): String =
        if (decoder is JsonDecoder) {
            val e = decoder.decodeJsonElement()
            if (e !is JsonPrimitive || e is JsonNull) throw SerializationException("bot id must be a string or a number")
            e.content
        } else {
            decoder.decodeString()
        }
}

/** A notification channel. */
@Serializable
data class Bot(
    @Serializable(with = BotIdSerializer::class) val id: String,
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
    @SerialName("bot_id") @Serializable(with = BotIdSerializer::class) val botId: String,
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
    /** `url`: tapping the notification opens [url] instead of the chat. */
    val open: String = "",
    /** An https image for the notification and the bubble. */
    val image: String = "",
    /** `Markdown` when [body] is Markdown. */
    @SerialName("parse_mode") val parseMode: String = "",
    /** Stored and counted, but with no banner. */
    val silent: Boolean = false,
    /** The sender's replaceable id (`id` in the bot API). */
    @SerialName("id") val collapseId: String = "",
    /** Unix milliseconds. */
    val date: Long = 0,
    /** The sender let the card's `request()` reach the bot (`allow_queries`). */
    @SerialName("allow_queries") val allowQueries: Boolean = false,
    /** The end-to-end sealed content ([Seal]); [MessageOpener] replaces it with the fields above. */
    val ciphertext: String = "",
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
    val botId: String,
    val title: String,
    val body: String,
    val html: String,
    val data: String,
    val level: String,
    val group: String,
    val url: String,
    val copy: String,
    val icon: String,
    val open: String,
    val image: String,
    val parseMode: String,
    val silent: Boolean,
    val collapseId: String,
    val date: Long,
    val read: Boolean,
    /** The sender let the card's `request()` reach the bot. */
    val allowQueries: Boolean = false,
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
    val botId: String,
    val targetId: Long = 0,
    val collapseId: String = "",
    val botName: String = "",
    val title: String = "",
    val body: String = "",
    val group: String = "",
    val level: String = "",
    /** A message sent with `silent`: store it, show no notification. */
    val silent: Boolean = false,
) {
    companion object {
        fun parse(data: Map<String, String>): PushInfo? {
            val kind = QueuedMessage.Kind.of(data["kind"]) ?: return null
            val id = data["msg_id"]?.toLongOrNull() ?: return null
            val bot = data["bot_id"]?.takeIf { it.isNotEmpty() } ?: return null
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
                silent = data["silent"] == "1",
            )
        }
    }
}
