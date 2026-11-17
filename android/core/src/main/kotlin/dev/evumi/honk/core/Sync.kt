package dev.evumi.honk.core

/** Pulls everything queued since the stored cursor, applies it and acks it, page by page. */
class SyncEngine(private val api: ApiClient, private val store: LocalStore) {
    data class Outcome(val applied: Int = 0, val staleNotificationIds: List<String> = emptyList())

    fun run(pageSize: Int = 100): Outcome {
        var applied = 0
        val stale = mutableListOf<String>()
        var cursor = store.syncCursor
        while (true) {
            val page = api.sync(cursor, pageSize)
            for (m in page.messages) {
                stale += store.apply(m).staleNotificationIds
                applied++
            }
            if (page.cursor > cursor) {
                cursor = page.cursor
                // Store the cursor before acking: if the ack fails, the next run
                // starts after these items and acks them with the next page.
                store.syncCursor = cursor
                api.ack(cursor)
            }
            if (!page.hasMore) break
        }
        return Outcome(applied, stale)
    }
}

/**
 * Bots stored under an integer id from before short ids would otherwise be
 * dropped, messages and all, once the gateway lists them by short id. Old
 * tokens keep working, so ask the gateway who each one is and move the local
 * data and the token over. A bot whose token is not stored is lost. Returns
 * the notification tags of the renamed messages (they name the old id).
 */
object LegacyBotIds {
    fun rename(store: LocalStore, tokens: BotTokenStore, api: ApiClient, known: Set<String>): List<String> {
        val tags = mutableListOf<String>()
        for (old in store.botIds()) {
            if (!BotIds.isLegacy(old) || old in known) continue
            val token = tokens.token(old) ?: continue
            val bot = try {
                api.getMe(token)
            } catch (e: java.io.IOException) {
                continue
            }
            if (bot.id !in known) continue
            tags += store.renameBot(old, bot.id)
            tokens.save(bot.id, token)
            tokens.remove(old)
        }
        return tags
    }
}
