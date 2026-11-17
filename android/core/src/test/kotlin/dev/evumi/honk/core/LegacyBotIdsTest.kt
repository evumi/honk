package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/** A store with legacy bots "4" (pinned, one message with tag "c4:dep") and "5". */
fun legacyStore(): LocalStore {
    val store = LocalStore(JdbcSql(tempPath()))
    store.saveBot(Bot("4", "部署", createdAt = 100))
    store.saveBot(Bot("5", "告警", createdAt = 200))
    store.setPinned("4", true)
    store.apply(QueuedMessage(1, "4", body = "old", collapseId = "dep"), "c4:dep")
    return store
}

val serverBots = listOf(Bot("aZ3kQ9xT", "部署", createdAt = 100), Bot("bQ7mN2pR", "告警", createdAt = 200))

// The same cases as LegacyBotIDTests in ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class LegacyBotIdsTest {
    @Test fun renamesByTokenAndByCreationAndName() {
        val store = legacyStore()
        val tokens = MemoryTokens(mutableMapOf("4" to "4:sec"))
        val out = LegacyBotIds.rename(store, tokens, serverBots) { token ->
            assertEquals("4:sec", token)
            serverBots[0]
        }
        assertEquals(listOf(LegacyBotIds.Rename("4", "aZ3kQ9xT"), LegacyBotIds.Rename("5", "bQ7mN2pR")), out.renamed)
        assertTrue(out.pending.isEmpty())
        store.replaceBots(serverBots, keeping = out.pending)
        assertEquals(listOf("old"), store.messages("aZ3kQ9xT").map { it.body })
        assertTrue(store.chats().first { it.bot.id == "aZ3kQ9xT" }.pinned)
        assertEquals(mapOf("aZ3kQ9xT" to "4:sec"), tokens.map)
        // Taps on notifications and shortcuts from before the rename still find the bot.
        assertEquals("aZ3kQ9xT", store.currentBotId("4"))
        assertEquals("aZ3kQ9xT", store.currentBotId("aZ3kQ9xT"))
        assertEquals("9", store.currentBotId("9"))
        // The old notification tag still removes it.
        assertEquals(listOf("c4:dep"), store.markRead("aZ3kQ9xT"))
    }

    @Test fun transientFailureKeepsTheBot() {
        val store = legacyStore()
        store.saveBot(Bot("6", "部署", createdAt = 100)) // a twin: no safe match by name
        val tokens = MemoryTokens(mutableMapOf("4" to "4:sec"))
        val out = LegacyBotIds.rename(store, tokens, serverBots) { throw IOException("timeout") }
        assertEquals(setOf("4"), out.pending)
        store.replaceBots(serverBots, keeping = out.pending)
        assertEquals("kept for the next try", listOf("old"), store.messages("4").map { it.body })
        assertEquals(mapOf("4" to "4:sec"), tokens.map)
        assertNull("an unmatched bot without a pending rename goes", store.bot("6"))
        // A 5xx is not definitive either.
        val again = LegacyBotIds.rename(store, tokens, serverBots) { throw ApiException.Gateway(502, "Bad Gateway") }
        assertEquals(setOf("4"), again.pending)
    }

    @Test fun pendingBotMergesIntoItsListedRowLater() {
        // Refresh 1: getMe is offline, so "4" stays pending while the list's short id is stored too.
        val store = legacyStore()
        store.saveBot(Bot("6", "部署", createdAt = 100)) // a twin: no safe match by name
        store.setMuted("4", true)
        val tokens = MemoryTokens(mutableMapOf("4" to "4:sec"))
        val first = LegacyBotIds.rename(store, tokens, serverBots) { throw IOException("offline") }
        store.replaceBots(serverBots, keeping = first.pending)
        store.apply(QueuedMessage(2, "aZ3kQ9xT", body = "new"))
        assertTrue(store.bot("aZ3kQ9xT") != null && store.bot("4") != null)
        // Refresh 2: getMe answers; the two rows merge instead of the old one being dropped.
        val second = LegacyBotIds.rename(store, tokens, serverBots) { serverBots[0] }
        assertEquals(listOf(LegacyBotIds.Rename("4", "aZ3kQ9xT")), second.renamed)
        store.replaceBots(serverBots, keeping = second.pending)
        assertEquals(listOf("new", "old"), store.messages("aZ3kQ9xT").map { it.body })
        assertTrue(store.isMuted("aZ3kQ9xT"))
        assertTrue(store.chats().first { it.bot.id == "aZ3kQ9xT" }.pinned)
        assertNull(store.bot("4"))
        assertEquals(mapOf("aZ3kQ9xT" to "4:sec"), tokens.map)
    }

    @Test fun getMeAnswerIsNotSecondGuessedByName() {
        // The token names a bot the gateway no longer lists: no matching by name and time.
        val store = legacyStore()
        val out = LegacyBotIds.rename(store, MemoryTokens(mutableMapOf("4" to "4:sec")), serverBots) {
            Bot("gone1234", "部署", createdAt = 100)
        }
        assertEquals(listOf(LegacyBotIds.Rename("5", "bQ7mN2pR")), out.renamed)
    }

    @Test fun goneTokenFallsBackToCreationAndName() {
        val store = legacyStore()
        val out = LegacyBotIds.rename(store, MemoryTokens(mutableMapOf("4" to "4:old")), serverBots) {
            throw ApiException.Gateway(401, "Unauthorized")
        }
        assertEquals(listOf("aZ3kQ9xT", "bQ7mN2pR"), out.renamed.map { it.new })
        assertTrue(out.pending.isEmpty())
    }

    @Test fun noMatchIsDropped() {
        val store = legacyStore()
        val others = listOf(Bot("cX1", "别的", createdAt = 100))
        val out = LegacyBotIds.rename(store, MemoryTokens(), others) { fail("no token, no getMe"); throw IllegalStateException() }
        assertEquals(LegacyBotIds.Outcome(), out)
        store.replaceBots(others, keeping = out.pending)
        assertEquals(listOf("cX1"), store.botIds())
    }
}
