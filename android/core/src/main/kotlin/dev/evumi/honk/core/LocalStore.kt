package dev.evumi.honk.core

/**
 * The device's SQLite database: bots with their local flags (muted, pinned),
 * messages, and the sync cursor.
 *
 * The tables and the semantics of [apply] match ios/HonkKit's LocalStore.swift:
 * a message with a collapse id replaces older ones of the same bot; an edit or
 * delete finds its message by `target_id`, else the newest with the collapse
 * id; applying the same item twice is safe (the FCM service and a later sync
 * both see it). Every method is synchronized: the FCM service and the UI share
 * one instance in the app's process.
 */
class LocalStore(private val sql: Sql) {
    private val lock = Any()
    private var inTransaction = false

    init {
        migrate()
    }

    private fun migrate() {
        if ((scalar("PRAGMA user_version") ?: 0) < 1) {
            transaction {
                SCHEMA_V1.forEach { sql.exec(it) }
                sql.exec("PRAGMA user_version = 1")
            }
        }
        if ((scalar("PRAGMA user_version") ?: 0) < 2) {
            transaction {
                MIGRATE_V2.forEach { sql.exec(it) }
                sql.exec("PRAGMA user_version = 2")
            }
        }
    }

    // applying queued items

    /** Applies an item from the gateway. Safe to call twice with the same item. */
    fun apply(m: QueuedMessage, notificationId: String? = null): ApplyResult = locked {
        transaction {
            when (m.kind) {
                QueuedMessage.Kind.MESSAGE -> insert(m, notificationId)
                QueuedMessage.Kind.EDIT -> edit(m)
                QueuedMessage.Kind.DELETE -> remove(m)
            }
        }
    }

    private fun insert(m: QueuedMessage, notificationId: String?): ApplyResult {
        val stale = mutableListOf<String>()
        if (m.collapseId.isNotEmpty()) {
            // A newer message with the same id replaces older ones.
            val older = sql.query(
                "SELECT id, notif_id FROM messages WHERE bot_id = ? AND collapse_id = ? AND id <> ?",
                listOf(m.botId, m.collapseId, m.id),
            ) { it.long(0) to it.text(1) }
            for ((id, notif) in older) {
                if (notif != null && notif != notificationId) stale += notif
                sql.run("DELETE FROM messages WHERE id = ?", listOf(id))
            }
        }
        sql.run(
            """
            INSERT INTO messages (id, bot_id, title, body, html, data, level, group_key, url, copy_text, icon, collapse_id, date, notif_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, notif_id = COALESCE(messages.notif_id, excluded.notif_id)
            """.trimIndent(),
            listOf(
                m.id, m.botId, m.title, m.body, m.html, m.data, m.level, m.group, m.url, m.copy, m.icon,
                m.collapseId, m.date, notificationId,
            ),
        )
        return ApplyResult(message = messageUnlocked(m.id), staleNotificationIds = stale)
    }

    /** The stored message an edit or delete points at: by id, else the latest with the collapse id. */
    private fun target(m: QueuedMessage): Long? {
        if (m.targetId > 0 && scalar("SELECT id FROM messages WHERE id = ? AND bot_id = ?", listOf(m.targetId, m.botId)) != null) {
            return m.targetId
        }
        if (m.collapseId.isNotEmpty()) {
            return scalar(
                "SELECT id FROM messages WHERE bot_id = ? AND collapse_id = ? ORDER BY id DESC LIMIT 1",
                listOf(m.botId, m.collapseId),
            )
        }
        return null
    }

    private fun edit(m: QueuedMessage): ApplyResult {
        val id = target(m) ?: return ApplyResult()
        sql.run("UPDATE messages SET data = ? WHERE id = ?", listOf(m.data, id))
        return ApplyResult(message = messageUnlocked(id))
    }

    private fun remove(m: QueuedMessage): ApplyResult {
        val id = target(m) ?: return ApplyResult()
        val notif = sql.query("SELECT notif_id FROM messages WHERE id = ?", listOf(id)) { it.text(0) }.firstOrNull()
        sql.run("DELETE FROM messages WHERE id = ?", listOf(id))
        return ApplyResult(message = null, staleNotificationIds = listOfNotNull(notif))
    }

    // bots

    /**
     * Replaces the stored bots with the gateway's list, keeping local flags and dropping messages of bots that are gone.
     * [keeping] names stored bots to leave alone although the list lacks them: legacy-id bots whose rename failed for
     * now (see [LegacyBotIds]).
     */
    fun replaceBots(bots: List<Bot>, keeping: Set<String> = emptySet()) = locked {
        transaction {
            bots.forEach(::upsert)
            val ids = bots.map { it.id } + keeping.sorted()
            val marks = ids.joinToString(",") { "?" }
            val keep = if (ids.isEmpty()) "" else " WHERE id NOT IN ($marks)"
            val keepMsg = if (ids.isEmpty()) "" else " WHERE bot_id NOT IN ($marks)"
            sql.run("DELETE FROM messages$keepMsg", ids)
            sql.run("DELETE FROM bots$keep", ids)
        }
    }

    /**
     * Moves a bot's local data (flags, messages) from [old] to [new]: the
     * gateway gave a bot known by a legacy integer id its short id. Delivered
     * notifications keep their tags (still in `notif_id`), so they can be
     * removed as before. Records old → new for [currentBotId]. Returns whether
     * it renamed. Same as LocalStore.swift.
     */
    fun renameBot(old: String, new: String): Boolean = locked {
        transaction {
            if (old == new || scalar("SELECT COUNT(*) FROM bots WHERE id = ?", listOf(old)) != 1L ||
                scalar("SELECT COUNT(*) FROM bots WHERE id = ?", listOf(new)) != 0L
            ) return@transaction false
            sql.run("UPDATE bots SET id = ? WHERE id = ?", listOf(new, old))
            sql.run("UPDATE messages SET bot_id = ? WHERE bot_id = ?", listOf(new, old))
            sql.run(
                "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                listOf("renamed-bot:$old", new),
            )
            true
        }
    }

    /** The id a bot has now: [id], or the short id a legacy id was renamed to (an old notification or shortcut names it). */
    fun currentBotId(id: String): String {
        if (!BotIds.isLegacy(id)) return id
        return locked {
            sql.query("SELECT value FROM meta WHERE key = ?", listOf("renamed-bot:$id")) { it.text(0) }.firstOrNull()
        } ?: id
    }

    /** The stored bots, oldest first. */
    fun bots(): List<Bot> = locked {
        sql.query("SELECT id, name, avatar, default_level, created_at, updated_at FROM bots ORDER BY created_at, id") {
            Bot(it.text(0).orEmpty(), it.text(1).orEmpty(), it.text(2).orEmpty(), it.text(3) ?: "active", it.long(4), it.long(5))
        }
    }

    /** The ids of the stored bots. */
    fun botIds(): List<String> = locked { sql.query("SELECT id FROM bots") { it.text(0).orEmpty() } }

    fun saveBot(b: Bot) = locked { upsert(b) }

    private fun upsert(b: Bot) {
        sql.run(
            """
            INSERT INTO bots (id, name, avatar, default_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
              default_level = excluded.default_level, updated_at = excluded.updated_at
            """.trimIndent(),
            listOf(b.id, b.name, b.avatar, b.defaultLevel, b.createdAt, b.updatedAt),
        )
    }

    fun bot(id: String): Bot? = locked {
        sql.query("SELECT id, name, avatar, default_level, created_at, updated_at FROM bots WHERE id = ?", listOf(id)) {
            Bot(it.text(0).orEmpty(), it.text(1).orEmpty(), it.text(2).orEmpty(), it.text(3) ?: "active", it.long(4), it.long(5))
        }.firstOrNull()
    }

    fun deleteBot(id: String) = locked {
        transaction {
            sql.run("DELETE FROM messages WHERE bot_id = ?", listOf(id))
            sql.run("DELETE FROM bots WHERE id = ?", listOf(id))
        }
    }

    fun setMuted(botId: String, muted: Boolean) = locked { sql.run("UPDATE bots SET muted = ? WHERE id = ?", listOf(muted, botId)) }

    fun setPinned(botId: String, pinned: Boolean) = locked { sql.run("UPDATE bots SET pinned = ? WHERE id = ?", listOf(pinned, botId)) }

    fun isMuted(botId: String): Boolean = locked { scalar("SELECT muted FROM bots WHERE id = ?", listOf(botId)) == 1L }

    // reading

    fun message(id: Long): StoredMessage? = locked { messageUnlocked(id) }

    private fun messageUnlocked(id: Long): StoredMessage? =
        sql.query("SELECT $MESSAGE_COLS FROM messages WHERE id = ?", listOf(id), ::readMessage).firstOrNull()

    /** A bot's messages, newest first, older than [before] when given. */
    fun messages(botId: String, before: Long? = null, limit: Int = 50): List<StoredMessage> = locked {
        sql.query(
            "SELECT $MESSAGE_COLS FROM messages WHERE bot_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
            listOf(botId, before ?: Long.MAX_VALUE, limit),
            ::readMessage,
        )
    }

    /** The chat list: pinned first, then by latest message. */
    fun chats(): List<ChatSummary> = locked {
        val rows = sql.query(
            """
            SELECT b.id, b.name, b.avatar, b.default_level, b.created_at, b.updated_at, b.muted, b.pinned,
                   (SELECT COUNT(*) FROM messages m WHERE m.bot_id = b.id AND m.read = 0),
                   (SELECT MAX(id) FROM messages m WHERE m.bot_id = b.id)
            FROM bots b
            """.trimIndent(),
        ) { r ->
            ChatSummary(
                bot = Bot(r.text(0).orEmpty(), r.text(1).orEmpty(), r.text(2).orEmpty(), r.text(3) ?: "active", r.long(4), r.long(5)),
                muted = r.long(6) != 0L,
                pinned = r.long(7) != 0L,
                last = null,
                unread = r.long(8).toInt(),
            ) to (if (r.isNull(9)) null else r.long(9))
        }
        rows.map { (chat, lastId) -> if (lastId != null) chat.copy(last = messageUnlocked(lastId)) else chat }
            .sortedWith(
                compareByDescending<ChatSummary> { it.pinned }
                    .thenByDescending { it.last?.date ?: it.bot.createdAt },
            )
    }

    /** Unread messages of bots that are not muted: the badge. */
    fun unreadTotal(): Int = locked {
        (scalar("SELECT COUNT(*) FROM messages m JOIN bots b ON b.id = m.bot_id WHERE m.read = 0 AND b.muted = 0") ?: 0).toInt()
    }

    /** How many of a bot's messages are unread. */
    fun unreadCount(botId: String): Int = locked {
        (scalar("SELECT COUNT(*) FROM messages WHERE bot_id = ? AND read = 0", listOf(botId)) ?: 0).toInt()
    }

    /** Marks a bot's messages read and returns their notification ids, to clear them. */
    fun markRead(botId: String): List<String> = locked {
        transaction {
            val ids = sql.query(
                "SELECT notif_id FROM messages WHERE bot_id = ? AND read = 0 AND notif_id IS NOT NULL",
                listOf(botId),
            ) { it.text(0) }.filterNotNull()
            sql.run("UPDATE messages SET read = 1 WHERE bot_id = ? AND read = 0", listOf(botId))
            ids
        }
    }

    /** Deletes one message on this device only; returns its notification id. */
    fun deleteMessage(id: Long): String? = locked {
        transaction {
            val notif = sql.query("SELECT notif_id FROM messages WHERE id = ?", listOf(id)) { it.text(0) }.firstOrNull()
            sql.run("DELETE FROM messages WHERE id = ?", listOf(id))
            notif
        }
    }

    /** Deletes a bot's messages on this device; returns their notification ids. */
    fun clearMessages(botId: String): List<String> = locked {
        transaction {
            val ids = sql.query("SELECT notif_id FROM messages WHERE bot_id = ? AND notif_id IS NOT NULL", listOf(botId)) {
                it.text(0)
            }.filterNotNull()
            sql.run("DELETE FROM messages WHERE bot_id = ?", listOf(botId))
            ids
        }
    }

    /** Forgets every bot, message and the sync cursor: the device moved to another gateway. Returns the notification ids to remove. */
    fun reset(): List<String> = locked {
        transaction {
            val ids = sql.query("SELECT notif_id FROM messages WHERE notif_id IS NOT NULL") { it.text(0) }.filterNotNull()
            sql.exec("DELETE FROM messages")
            sql.exec("DELETE FROM bots")
            sql.exec("DELETE FROM meta")
            ids
        }
    }

    // meta

    var syncCursor: Long
        get() = locked {
            sql.query("SELECT value FROM meta WHERE key = 'cursor'") { it.text(0) }.firstOrNull()?.toLongOrNull() ?: 0
        }
        set(value) = locked {
            sql.run(
                "INSERT INTO meta (key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                listOf(value.toString()),
            )
        }

    fun close() = locked { sql.close() }

    // plumbing

    private inline fun <T> locked(body: () -> T): T = synchronized(lock) { body() }

    private fun <T> transaction(body: () -> T): T {
        if (inTransaction) return body()
        return sql.transaction {
            inTransaction = true
            try {
                body()
            } finally {
                inTransaction = false
            }
        }
    }

    private fun scalar(q: String, args: List<Any?> = emptyList()): Long? =
        sql.query(q, args) { if (it.isNull(0)) null else it.long(0) }.firstOrNull()

    companion object {
        private const val MESSAGE_COLS =
            "id, bot_id, title, body, html, data, level, group_key, url, copy_text, icon, collapse_id, date, read"

        private fun readMessage(r: Sql.Row) = StoredMessage(
            id = r.long(0), botId = r.text(1).orEmpty(), title = r.text(2).orEmpty(), body = r.text(3).orEmpty(),
            html = r.text(4).orEmpty(), data = r.text(5).orEmpty(), level = r.text(6).orEmpty(),
            group = r.text(7).orEmpty(), url = r.text(8).orEmpty(), copy = r.text(9).orEmpty(),
            icon = r.text(10).orEmpty(), collapseId = r.text(11).orEmpty(), date = r.long(12), read = r.long(13) != 0L,
        )

        /** Version 1, the same tables as ios/HonkKit/Sources/HonkKit/LocalStore.swift. One statement per entry. */
        val SCHEMA_V1 = listOf(
            """
            CREATE TABLE bots (
              id            INTEGER PRIMARY KEY,
              name          TEXT NOT NULL,
              avatar        TEXT NOT NULL DEFAULT '',
              default_level TEXT NOT NULL DEFAULT 'active',
              muted         INTEGER NOT NULL DEFAULT 0,
              pinned        INTEGER NOT NULL DEFAULT 0,
              created_at    INTEGER NOT NULL DEFAULT 0,
              updated_at    INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
            """
            CREATE TABLE messages (
              id          INTEGER PRIMARY KEY,
              bot_id      INTEGER NOT NULL,
              title       TEXT NOT NULL DEFAULT '',
              body        TEXT NOT NULL DEFAULT '',
              html        TEXT NOT NULL DEFAULT '',
              data        TEXT NOT NULL DEFAULT '',
              level       TEXT NOT NULL DEFAULT '',
              group_key   TEXT NOT NULL DEFAULT '',
              url         TEXT NOT NULL DEFAULT '',
              copy_text   TEXT NOT NULL DEFAULT '',
              icon        TEXT NOT NULL DEFAULT '',
              collapse_id TEXT NOT NULL DEFAULT '',
              date        INTEGER NOT NULL,
              read        INTEGER NOT NULL DEFAULT 0,
              notif_id    TEXT
            )
            """.trimIndent(),
            "CREATE INDEX messages_bot ON messages(bot_id, id)",
            "CREATE INDEX messages_collapse ON messages(bot_id, collapse_id) WHERE collapse_id <> ''",
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        )

        /**
         * Version 2: bot ids are short strings. Rebuilds both tables with TEXT
         * bot ids (an INTEGER column would turn "123" back into a number); the
         * integer ids already stored become their decimal text until the
         * gateway's list renames them ([renameBot]). Same as LocalStore.swift.
         */
        val MIGRATE_V2 = listOf(
            """
            CREATE TABLE bots_v2 (
              id            TEXT PRIMARY KEY,
              name          TEXT NOT NULL,
              avatar        TEXT NOT NULL DEFAULT '',
              default_level TEXT NOT NULL DEFAULT 'active',
              muted         INTEGER NOT NULL DEFAULT 0,
              pinned        INTEGER NOT NULL DEFAULT 0,
              created_at    INTEGER NOT NULL DEFAULT 0,
              updated_at    INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
            "INSERT INTO bots_v2 SELECT CAST(id AS TEXT), name, avatar, default_level, muted, pinned, created_at, updated_at FROM bots",
            "DROP TABLE bots",
            "ALTER TABLE bots_v2 RENAME TO bots",
            """
            CREATE TABLE messages_v2 (
              id          INTEGER PRIMARY KEY,
              bot_id      TEXT NOT NULL,
              title       TEXT NOT NULL DEFAULT '',
              body        TEXT NOT NULL DEFAULT '',
              html        TEXT NOT NULL DEFAULT '',
              data        TEXT NOT NULL DEFAULT '',
              level       TEXT NOT NULL DEFAULT '',
              group_key   TEXT NOT NULL DEFAULT '',
              url         TEXT NOT NULL DEFAULT '',
              copy_text   TEXT NOT NULL DEFAULT '',
              icon        TEXT NOT NULL DEFAULT '',
              collapse_id TEXT NOT NULL DEFAULT '',
              date        INTEGER NOT NULL,
              read        INTEGER NOT NULL DEFAULT 0,
              notif_id    TEXT
            )
            """.trimIndent(),
            """
            INSERT INTO messages_v2 SELECT id, CAST(bot_id AS TEXT), title, body, html, data, level, group_key, url,
              copy_text, icon, collapse_id, date, read, notif_id FROM messages
            """.trimIndent(),
            "DROP TABLE messages",
            "ALTER TABLE messages_v2 RENAME TO messages",
            "CREATE INDEX messages_bot ON messages(bot_id, id)",
            "CREATE INDEX messages_collapse ON messages(bot_id, collapse_id) WHERE collapse_id <> ''",
        )
    }
}
