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
 * Moves bots stored under an integer id (from before short ids) to the short
 * id the gateway now lists them by, so their messages, flags and token are not
 * dropped. The same rules as ios/HonkKit's `LegacyBotIDs`:
 *
 * 1. With a stored token, ask `getMe` (old tokens keep working) which bot it is.
 * 2. Otherwise, or when the gateway says the token is gone (401/404), match on
 *    `created_at` + name when exactly one listed bot, not yet stored, has both.
 * 3. A bot whose `getMe` failed for another reason (offline, timeout, 5xx) and
 *    that did not match stays pending: keep it (`replaceBots(keeping =)`) and
 *    try again next time.
 *
 * Delivered notifications are left alone on both platforms; their stored tags
 * still remove them.
 */
object LegacyBotIds {
    data class Rename(val old: String, val new: String)
    data class Outcome(val renamed: List<Rename> = emptyList(), val pending: Set<String> = emptySet())

    fun rename(store: LocalStore, tokens: BotTokenStore, serverBots: List<Bot>, getMe: (String) -> Bot): Outcome {
        val local = store.bots()
        val known = serverBots.map { it.id }.toSet()
        val legacy = local.filter { BotIds.isLegacy(it.id) && it.id !in known }
        if (legacy.isEmpty()) return Outcome()
        val stored = local.map { it.id }.toSet()
        val claimed = mutableSetOf<String>()
        val renamed = mutableListOf<Rename>()
        val pending = mutableSetOf<String>()

        for (bot in legacy) {
            var newId: String? = null
            var transient = false
            var answered = false // getMe named the bot: no guessing by name then
            val token = tokens.token(bot.id)
            if (token != null) {
                try {
                    val me = getMe(token)
                    answered = true
                    if (me.id in known) newId = me.id
                } catch (e: ApiException.Gateway) {
                    // 401/404: the token no longer names a bot. Anything else may pass.
                    if (e.code != 401 && e.code != 404) transient = true
                } catch (e: Exception) {
                    transient = true
                }
            }
            if (newId == null && !answered) {
                val twins = legacy.count { it.createdAt == bot.createdAt && it.name == bot.name }
                val matches = serverBots.filter {
                    it.id !in stored && it.id !in claimed && it.createdAt == bot.createdAt && it.name == bot.name
                }
                if (twins == 1 && matches.size == 1) newId = matches[0].id
            }
            val id = newId
            if (id == null || id in claimed || !store.renameBot(bot.id, id)) {
                if (transient) pending += bot.id
                continue
            }
            claimed += id
            if (token != null) {
                // A token saved under the short id meanwhile (a reset) is newer.
                if (tokens.token(id) == null) tokens.save(id, token)
                tokens.remove(bot.id)
            }
            renamed += Rename(bot.id, id)
        }
        return Outcome(renamed, pending)
    }

    /** Whether any stored bot still has a legacy id. */
    fun hasLegacy(store: LocalStore): Boolean = store.botIds().any(BotIds::isLegacy)

    /**
     * For a push: while legacy-id bots are stored, fetch the bot list and
     * rename first, so the push finds its bot's name, avatar and mute flag (a
     * refresh may already have stored the short id while the legacy row was
     * pending). The list is then applied as a refresh would, so legacy rows
     * that match nothing go and later pushes skip all this. Pass a client with
     * a short timeout. Returns what it renamed; nothing on any failure.
     */
    fun renameBeforePush(store: LocalStore, tokens: BotTokenStore, api: ApiClient): Outcome {
        if (!hasLegacy(store)) return Outcome()
        val bots = try {
            api.listBots()
        } catch (e: Exception) {
            return Outcome()
        }
        val out = rename(store, tokens, bots) { api.getMe(it) }
        store.replaceBots(bots, keeping = out.pending)
        return out
    }
}
