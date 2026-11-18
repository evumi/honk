package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Date

// The same cases as ios/HonkKit/Tests/HonkKitTests/SearchRetentionArchiveTests.swift.
class SearchRetentionArchiveTest {
    private fun QueuedMessageIds(l: List<StoredMessage>) = l.map { it.id }

    @Test fun searchMatchesTitleAndBodyNewestFirstInPages() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", title = "Deploy ok", body = "x", date = 1))
        store.apply(QueuedMessage(2, "b2", title = "t", body = "the DEPLOY failed", date = 2))
        store.apply(QueuedMessage(3, "b1", title = "部署完成", body = "", date = 3))
        store.apply(QueuedMessage(4, "b1", title = "other", body = "none", date = 4))
        assertEquals("ASCII case-insensitive, across bots", listOf(2L, 1L), QueuedMessageIds(store.search("deploy")))
        assertEquals(listOf(3L), QueuedMessageIds(store.search("部署")))
        assertEquals(listOf(2L), QueuedMessageIds(store.search("deploy", limit = 1)))
        assertEquals(listOf(1L), QueuedMessageIds(store.search("deploy", before = 2, limit = 1)))
        assertTrue(store.search("   ").isEmpty())
    }

    @Test fun wildcardsAreLiteral() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", title = "100% done", date = 1))
        store.apply(QueuedMessage(2, "b1", title = "a_b", date = 2))
        store.apply(QueuedMessage(3, "b1", title = "axb", date = 3))
        store.apply(QueuedMessage(4, "b1", title = "back\\slash", date = 4))
        assertEquals(listOf(1L), QueuedMessageIds(store.search("%")))
        assertEquals(listOf(2L), QueuedMessageIds(store.search("_")))
        assertEquals(listOf(2L), QueuedMessageIds(store.search("a_b")))
        assertEquals(listOf(4L), QueuedMessageIds(store.search("\\")))
    }

    @Test fun windowAroundAMessage() {
        val store = tempStore()
        for (i in 1L..100L) store.apply(QueuedMessage(i, "b1", body = "m$i", date = i))
        store.apply(QueuedMessage(500, "b2", body = "other bot", date = 500))
        assertEquals(
            "five newer, the message and the rest older",
            listOf(55L, 54, 53, 52, 51, 50, 49, 48, 47, 46),
            QueuedMessageIds(store.messagesAround("b1", 50, 10)),
        )
        assertEquals(listOf(100L, 99, 98, 97, 96, 95, 94, 93, 92, 91), QueuedMessageIds(store.messagesAround("b1", 99, 10)))
        assertEquals("not this bot's message: the newest", listOf(100L, 99, 98), QueuedMessageIds(store.messagesAround("b1", 500, 3)))
    }

    @Test fun retentionPrunesOldMessagesAndReturnsTheirNotifications() {
        val store = tempStore()
        val day = 86_400_000L
        val now = 1_000 * day
        store.apply(QueuedMessage(1, "b1", body = "old", date = now - 40 * day), "n1")
        store.apply(QueuedMessage(2, "b1", body = "recent", date = now - 10 * day), "n2")
        store.apply(QueuedMessage(3, "b2", body = "older", date = now - 400 * day))

        assertEquals(0, store.retentionDays)
        assertTrue("forever keeps everything", store.pruneExpired(now).isEmpty())
        assertEquals(3, store.exportMessages().size)

        store.retentionDays = 30
        assertEquals(30, store.retentionDays)
        assertEquals(listOf("n1"), store.pruneExpired(now))
        assertEquals(listOf(2L), QueuedMessageIds(store.exportMessages()))

        store.retentionDays = 365
        store.apply(QueuedMessage(4, "b1", body = "x", date = now - 366 * day))
        store.pruneExpired(now)
        assertEquals(listOf(2L), QueuedMessageIds(store.exportMessages()))
    }

    @Test fun retentionChoiceSurvivesAGatewayReset() {
        val store = tempStore()
        store.retentionDays = 90
        store.syncCursor = 7
        store.reset()
        assertEquals(90, store.retentionDays)
        assertEquals(0L, store.syncCursor)
    }

    @Test fun archiveLinesMatchTheAppApiAndRoundTrip() {
        val store = tempStore()
        store.apply(
            QueuedMessage(
                1, "b1", title = "部署", body = "完成 \"ok\"\n第二行", html = "<b>x</b>", data = """{"a":1}""", level = "active",
                group = "g", url = "https://x.test/a", copy = "c", icon = "bell", open = "url", image = "https://x.test/i.png",
                parseMode = "Markdown", silent = true, collapseId = "dep", date = 10,
            ),
        )
        store.apply(QueuedMessage(2, "b2", body = "plain", date = 20))
        val text = MessageArchive.encode(store.exportMessages())
        val lines = text.trimEnd('\n').split('\n')
        assertEquals(2, lines.size)
        assertEquals("empty fields are left out", """{"body":"plain","bot_id":"b2","date":20,"kind":"message","message_id":2}""", lines[1])
        assertTrue("the collapse id is `id`, as in the API", lines[0].contains(""""id":"dep""""))

        val back = MessageArchive.decode(text)
        assertEquals(0, back.invalid)
        assertEquals(2, back.messages.size)
        assertEquals("dep", back.messages[0].collapseId)
        assertEquals("完成 \"ok\"\n第二行", back.messages[0].body)
        val m = back.messages[0]
        assertTrue(m.open == "url" && m.image == "https://x.test/i.png" && m.parseMode == "Markdown" && m.silent)
        assertTrue(!back.messages[1].silent && back.messages[1].open == "")
        // Importing keeps them.
        val target = tempStore()
        target.importMessages(back.messages)
        val kept = target.message(1)!!
        assertTrue(kept.open == "url" && kept.image == "https://x.test/i.png" && kept.parseMode == "Markdown" && kept.silent)
    }

    @Test fun badLinesAreCounted() {
        val text = "\n{\"message_id\":1,\"bot_id\":\"b\",\"kind\":\"message\",\"date\":1}\r\nnot json\n{\"bot_id\":\"b\"}\n  \n"
        val d = MessageArchive.decode(text)
        assertEquals(listOf(1L), d.messages.map { it.id })
        assertEquals(2, d.invalid)
    }

    @Test fun importIsIdempotentAndSkipsUnknownBots() {
        val source = tempStore()
        source.apply(QueuedMessage(1, "b1", body = "a", collapseId = "k", date = 1))
        source.apply(QueuedMessage(2, "b1", body = "b", date = 2))
        source.apply(QueuedMessage(3, "b2", body = "c", date = 3))
        source.apply(QueuedMessage(4, "b1", body = "newer k", collapseId = "k", date = 4))
        val archive = MessageArchive.encode(source.exportMessages("b1"))
        assertEquals(listOf(2L, 4L), QueuedMessageIds(source.exportMessages("b1")))

        val target = tempStore()
        target.deleteBot("b2")
        val items = MessageArchive.decode(archive).messages + QueuedMessage(9, "gone", body = "z", date = 9)
        assertEquals(LocalStore.ImportSummary(imported = 2, existing = 0, unknownBot = 1), target.importMessages(items))
        assertEquals(listOf(2L, 4L), QueuedMessageIds(target.exportMessages()))
        assertEquals("imported messages arrive read", 0, target.unreadCount("b1"))

        assertEquals(LocalStore.ImportSummary(imported = 0, existing = 2, unknownBot = 1), target.importMessages(items))
        assertEquals(listOf(2L, 4L), QueuedMessageIds(target.exportMessages()))

        // An older message of a collapse id does not replace a newer stored one.
        val old = target.importMessages(listOf(QueuedMessage(1, "b1", body = "a", collapseId = "k", date = 1)))
        assertEquals(1, old.existing)
        assertEquals(listOf(2L, 4L), QueuedMessageIds(target.exportMessages()))
    }

    @Test fun fileNames() {
        val d = Date(1_767_312_000_000L)
        assertTrue(MessageArchive.fileName(null, d).startsWith("honk-all-"))
        assertTrue(MessageArchive.fileName("My Bot/部署", d).startsWith("honk-My-Bot-部署-"))
        assertTrue(MessageArchive.fileName("///", d).startsWith("honk-bot-"))
    }
}
