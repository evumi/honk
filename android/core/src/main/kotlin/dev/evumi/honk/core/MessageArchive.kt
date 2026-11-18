package dev.evumi.honk.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Messages as JSON Lines: one JSON object per line, in the shape of the message objects of the gateway's App API
 * (`message_id`, `bot_id`, `kind`, `title`, `body`, `html`, `data`, `level`, `group`, `url`, `copy`, `icon`, `id`
 * (the collapse id), `date`), with empty fields left out. A line is a [QueuedMessage], so an archive imports through
 * [LocalStore.importMessages]. Same as MessageArchive.swift in HonkKit.
 */
object MessageArchive {
    /** The file name an export is saved under, such as `honk-all-20260102.jsonl`. */
    fun fileName(botName: String?, now: Date = Date()): String {
        val day = SimpleDateFormat("yyyyMMdd", Locale.US).apply { timeZone = TimeZone.getDefault() }.format(now)
        val name = (botName ?: "all").map { if (it.isLetterOrDigit()) it else '-' }.joinToString("")
            .split('-').filter { it.isNotEmpty() }.joinToString("-")
        return "honk-${name.ifEmpty { "bot" }}-$day.jsonl"
    }

    /** The archive of [messages], one line each, in the order given. Keys are sorted, as in the iOS archive. */
    fun encode(messages: List<StoredMessage>): String = buildString {
        for (m in messages) {
            val fields = sortedMapOf<String, JsonElement>(
                "bot_id" to JsonPrimitive(m.botId), "date" to JsonPrimitive(m.date), "kind" to JsonPrimitive("message"),
                "message_id" to JsonPrimitive(m.id),
            )
            // Empty fields are left out, as the gateway does.
            for ((k, v) in listOf(
                "body" to m.body, "copy" to m.copy, "data" to m.data, "group" to m.group, "html" to m.html, "icon" to m.icon,
                "id" to m.collapseId, "image" to m.image, "level" to m.level, "open" to m.open, "parse_mode" to m.parseMode,
                "title" to m.title, "url" to m.url,
            )) if (v.isNotEmpty()) fields[k] = JsonPrimitive(v)
            if (m.silent) fields["silent"] = JsonPrimitive(true)
            if (m.allowQueries) fields["allow_queries"] = JsonPrimitive(true)
            append(JsonObject(fields).toString()).append('\n')
        }
    }

    /** What [decode] read: the messages, and how many non-empty lines it could not read. */
    data class Decoded(val messages: List<QueuedMessage>, val invalid: Int)

    /** Reads an archive; a line that is not a message object is counted, not fatal. */
    fun decode(text: String): Decoded {
        val out = mutableListOf<QueuedMessage>()
        var invalid = 0
        for (raw in text.lineSequence()) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val m = runCatching { ApiClient.JSON.decodeFromString(QueuedMessage.serializer(), line) }.getOrNull()
            // An archive is as untrusted as a sealed message: apply the limits the gateway checks for plaintext.
            if (m != null && m.id > 0 && m.botId.isNotEmpty()) out += ContentLimits.sanitize(m) else invalid++
        }
        return Decoded(out, invalid)
    }
}
