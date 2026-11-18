package dev.evumi.honk.core

/** What a message notification shows; the counterpart of `BannerText` in ios/HonkKit. */
data class BannerText(val botName: String, val title: String, val body: String)

object Banner {
    /**
     * Picks the banner text.
     *
     * A push the gateway sent without content (`HONK_PUSH_CONTENT=none`, the
     * default through a relay) carries only ids, so the text has to come from
     * the fetched [message] and the bot in the local store; a push with
     * content works as before when the fetch fails. [fallback] is the
     * localised "New notification", for when there is nothing else to show.
     */
    fun choose(message: StoredMessage?, botName: String?, push: PushInfo, fallback: String): BannerText {
        val name = listOf(botName.orEmpty(), push.botName).firstOrNull { it.isNotEmpty() } ?: "Honk"
        if (message == null) {
            return BannerText(name, push.title, push.body.ifEmpty { fallback })
        }
        val title = message.title.ifEmpty { push.title }
        val body = listOf(message.body, push.body).firstOrNull { it.isNotEmpty() } ?: fallback
        return BannerText(name, title, body)
    }

    /**
     * The notification tag, which LocalStore keeps as the message's notification
     * id: `c<bot>:<collapse id>` when the message has one (a newer message with
     * the same id replaces the notification in place), else `m<message id>`.
     * The collapse id comes from the fetched message; a push without content
     * carries none, so when the fetch fails the tag is `m<message id>`.
     */
    fun tag(botId: String, messageId: Long, collapseId: String): String =
        if (collapseId.isNotEmpty()) "c$botId:$collapseId" else "m$messageId"
}
