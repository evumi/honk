package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

fun tempPath(): String = File.createTempFile("honk", ".sqlite").apply { delete(); deleteOnExit() }.path

fun tempStore(): LocalStore {
    val store = LocalStore(JdbcSql(tempPath()))
    store.replaceBots(listOf(Bot(1, "部署"), Bot(2, "告警")))
    return store
}

// The same cases as ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class LocalStoreTest {
    @Test fun collapseEditDelete() {
        val store = tempStore()
        store.apply(QueuedMessage(10, 1, body = "部署中", data = """{"s":"部署中"}""", collapseId = "dep", date = 1), "n10")
        val r = store.apply(QueuedMessage(11, 1, body = "重试", collapseId = "dep", date = 2), "n11")
        assertEquals("the replaced message's notification goes", listOf("n10"), r.staleNotificationIds)
        assertNull(store.message(10))

        // An edit by collapse id reaches the newest message with it.
        val e = store.apply(QueuedMessage(12, 1, QueuedMessage.Kind.EDIT, data = """{"s":"已上线"}""", collapseId = "dep"))
        assertEquals(11L, e.message?.id)
        assertEquals("""{"s":"已上线"}""", store.message(11)?.data)

        // Another bot cannot edit it by id.
        store.apply(QueuedMessage(13, 2, QueuedMessage.Kind.EDIT, targetId = 11, data = "x"))
        assertEquals("""{"s":"已上线"}""", store.message(11)?.data)

        val d = store.apply(QueuedMessage(14, 1, QueuedMessage.Kind.DELETE, targetId = 11))
        assertEquals(listOf("n11"), d.staleNotificationIds)
        assertNull(store.message(11))
    }

    @Test fun collapseWithTheSameNotificationTagIsNotStale() {
        // On Android the notification tag is the collapse id, so the new
        // notification replaces the old one in place: nothing to remove.
        val store = tempStore()
        store.apply(QueuedMessage(1, 1, body = "a", collapseId = "dep"), "c1:dep")
        val r = store.apply(QueuedMessage(2, 1, body = "b", collapseId = "dep"), "c1:dep")
        assertEquals(emptyList<String>(), r.staleNotificationIds)
        assertEquals(listOf(2L), store.messages(1).map { it.id })
    }

    @Test fun editAndDeleteOfUnknownMessagesDoNothing() {
        val store = tempStore()
        assertEquals(ApplyResult(), store.apply(QueuedMessage(5, 1, QueuedMessage.Kind.EDIT, targetId = 99, data = "x")))
        assertEquals(ApplyResult(), store.apply(QueuedMessage(6, 1, QueuedMessage.Kind.DELETE, collapseId = "nope")))
        // A target id that is gone falls back to the collapse id.
        store.apply(QueuedMessage(7, 1, body = "a", collapseId = "k"), "n7")
        val d = store.apply(QueuedMessage(8, 1, QueuedMessage.Kind.DELETE, targetId = 99, collapseId = "k"))
        assertEquals(listOf("n7"), d.staleNotificationIds)
        // Deleting twice is safe.
        assertEquals(ApplyResult(), store.apply(QueuedMessage(8, 1, QueuedMessage.Kind.DELETE, targetId = 99, collapseId = "k")))
    }

    @Test fun applyTwiceKeepsReadAndNotification() {
        val store = tempStore()
        val m = QueuedMessage(20, 1, body = "x", date = 5)
        store.apply(m, "n20")
        store.markRead(1)
        store.apply(m) // the later sync sees it again
        assertEquals(true, store.message(20)?.read)
        assertEquals(listOf("n20"), store.clearMessages(1))
    }

    @Test fun applyTwiceWithCollapseKeepsTheMessage() {
        val store = tempStore()
        val m = QueuedMessage(30, 1, body = "x", collapseId = "c")
        store.apply(m, "t")
        val again = store.apply(m)
        assertEquals(emptyList<String>(), again.staleNotificationIds)
        assertEquals(30L, again.message?.id)
    }

    @Test fun chatsAndUnread() {
        val store = tempStore()
        store.apply(QueuedMessage(1, 1, body = "a", date = 100))
        store.apply(QueuedMessage(2, 2, body = "b", date = 200))
        store.apply(QueuedMessage(3, 2, body = "c", date = 300))
        var chats = store.chats()
        assertEquals("latest first", listOf(2L, 1L), chats.map { it.bot.id })
        assertEquals(2, chats.first().unread)
        assertEquals("c", chats.first().last?.body)
        assertEquals(3, store.unreadTotal())

        store.setPinned(1, true)
        store.setMuted(2, true)
        chats = store.chats()
        assertEquals("pinned first", listOf(1L, 2L), chats.map { it.bot.id })
        assertEquals("muted bots don't count", 1, store.unreadTotal())

        assertEquals(listOf(3L, 2L), store.messages(2).map { it.id })
        assertEquals(listOf(2L), store.messages(2, before = 3).map { it.id })
        assertEquals(listOf(3L), store.messages(2, limit = 1).map { it.id })
    }

    @Test fun unreadCountFollowsMarkRead() {
        val store = tempStore()
        store.apply(QueuedMessage(id = 1, botId = 1, body = "a"))
        store.apply(QueuedMessage(id = 2, botId = 1, body = "b"))
        assertEquals(2, store.unreadCount(1))
        store.markRead(1)
        assertEquals(0, store.unreadCount(1))
    }

    @Test fun markReadReturnsUnreadNotifications() {
        val store = tempStore()
        store.apply(QueuedMessage(1, 1, body = "a"), "n1")
        store.apply(QueuedMessage(2, 1, body = "b"))
        assertEquals(listOf("n1"), store.markRead(1))
        assertEquals(emptyList<String>(), store.markRead(1))
        assertEquals(0, store.unreadTotal())
    }

    @Test fun deleteMessageAndBot() {
        val store = tempStore()
        store.apply(QueuedMessage(1, 1, body = "a"), "n1")
        assertEquals("n1", store.deleteMessage(1))
        assertNull(store.deleteMessage(1))
        store.apply(QueuedMessage(2, 1, body = "b"))
        store.deleteBot(1)
        assertNull(store.bot(1))
        assertTrue(store.messages(1).isEmpty())
    }

    @Test fun replaceBotsDropsGoneBots() {
        val store = tempStore()
        store.apply(QueuedMessage(1, 2, body = "x"))
        store.setMuted(1, true)
        store.replaceBots(listOf(Bot(1, "改名")))
        assertNull(store.bot(2))
        assertTrue(store.messages(2).isEmpty())
        assertEquals("改名", store.bot(1)?.name)
        assertTrue("local flags survive", store.isMuted(1))
        store.replaceBots(emptyList())
        assertNull(store.bot(1))
    }

    @Test fun cursor() {
        val store = tempStore()
        assertEquals(0L, store.syncCursor)
        store.syncCursor = 42
        assertEquals(42L, store.syncCursor)
    }

    @Test fun reopenKeepsData() {
        val path = tempPath()
        LocalStore(JdbcSql(path)).apply {
            replaceBots(listOf(Bot(1, "b")))
            apply(QueuedMessage(5, 1, body = "kept"))
            close()
        }
        assertEquals("kept", LocalStore(JdbcSql(path)).messages(1).first().body)
    }
}
