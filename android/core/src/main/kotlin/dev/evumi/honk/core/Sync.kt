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
