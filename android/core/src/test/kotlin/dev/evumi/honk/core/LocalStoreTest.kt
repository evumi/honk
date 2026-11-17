package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

fun tempPath(): String = File.createTempFile("honk", ".sqlite").apply { delete(); deleteOnExit() }.path

fun tempStore(): LocalStore {
    val store = LocalStore(JdbcSql(tempPath()))
    store.replaceBots(listOf(Bot("b1", "部署"), Bot("b2", "告警")))
    return store
}

// The same cases as ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class LocalStoreTest {
    @Test fun collapseEditDelete() {
        val store = tempStore()
        store.apply(QueuedMessage(10, "b1", body = "部署中", data = """{"s":"部署中"}""", collapseId = "dep", date = 1), "n10")
        val r = store.apply(QueuedMessage(11, "b1", body = "重试", collapseId = "dep", date = 2), "n11")
        assertEquals("the replaced message's notification goes", listOf("n10"), r.staleNotificationIds)
        assertNull(store.message(10))

        // An edit by collapse id reaches the newest message with it.
        val e = store.apply(QueuedMessage(12, "b1", QueuedMessage.Kind.EDIT, data = """{"s":"已上线"}""", collapseId = "dep"))
        assertEquals(11L, e.message?.id)
        assertEquals("""{"s":"已上线"}""", store.message(11)?.data)

        // Another bot cannot edit it by id.
        store.apply(QueuedMessage(13, "b2", QueuedMessage.Kind.EDIT, targetId = 11, data = "x"))
        assertEquals("""{"s":"已上线"}""", store.message(11)?.data)

        val d = store.apply(QueuedMessage(14, "b1", QueuedMessage.Kind.DELETE, targetId = 11))
        assertEquals(listOf("n11"), d.staleNotificationIds)
        assertNull(store.message(11))
    }

    @Test fun collapseWithTheSameNotificationTagIsNotStale() {
        // On Android the notification tag is the collapse id, so the new
        // notification replaces the old one in place: nothing to remove.
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "a", collapseId = "dep"), "c1:dep")
        val r = store.apply(QueuedMessage(2, "b1", body = "b", collapseId = "dep"), "c1:dep")
        assertEquals(emptyList<String>(), r.staleNotificationIds)
        assertEquals(listOf(2L), store.messages("b1").map { it.id })
    }

    @Test fun editAndDeleteOfUnknownMessagesDoNothing() {
        val store = tempStore()
        assertEquals(ApplyResult(), store.apply(QueuedMessage(5, "b1", QueuedMessage.Kind.EDIT, targetId = 99, data = "x")))
        assertEquals(ApplyResult(), store.apply(QueuedMessage(6, "b1", QueuedMessage.Kind.DELETE, collapseId = "nope")))
        // A target id that is gone falls back to the collapse id.
        store.apply(QueuedMessage(7, "b1", body = "a", collapseId = "k"), "n7")
        val d = store.apply(QueuedMessage(8, "b1", QueuedMessage.Kind.DELETE, targetId = 99, collapseId = "k"))
        assertEquals(listOf("n7"), d.staleNotificationIds)
        // Deleting twice is safe.
        assertEquals(ApplyResult(), store.apply(QueuedMessage(8, "b1", QueuedMessage.Kind.DELETE, targetId = 99, collapseId = "k")))
    }

    @Test fun applyTwiceKeepsReadAndNotification() {
        val store = tempStore()
        val m = QueuedMessage(20, "b1", body = "x", date = 5)
        store.apply(m, "n20")
        store.markRead("b1")
        store.apply(m) // the later sync sees it again
        assertEquals(true, store.message(20)?.read)
        assertEquals(listOf("n20"), store.clearMessages("b1"))
    }

    @Test fun applyTwiceWithCollapseKeepsTheMessage() {
        val store = tempStore()
        val m = QueuedMessage(30, "b1", body = "x", collapseId = "c")
        store.apply(m, "t")
        val again = store.apply(m)
        assertEquals(emptyList<String>(), again.staleNotificationIds)
        assertEquals(30L, again.message?.id)
    }

    @Test fun chatsAndUnread() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "a", date = 100))
        store.apply(QueuedMessage(2, "b2", body = "b", date = 200))
        store.apply(QueuedMessage(3, "b2", body = "c", date = 300))
        var chats = store.chats()
        assertEquals("latest first", listOf("b2", "b1"), chats.map { it.bot.id })
        assertEquals(2, chats.first().unread)
        assertEquals("c", chats.first().last?.body)
        assertEquals(3, store.unreadTotal())

        store.setPinned("b1", true)
        store.setMuted("b2", true)
        chats = store.chats()
        assertEquals("pinned first", listOf("b1", "b2"), chats.map { it.bot.id })
        assertEquals("muted bots don't count", 1, store.unreadTotal())

        assertEquals(listOf(3L, 2L), store.messages("b2").map { it.id })
        assertEquals(listOf(2L), store.messages("b2", before = 3).map { it.id })
        assertEquals(listOf(3L), store.messages("b2", limit = 1).map { it.id })
    }

    @Test fun unreadCountFollowsMarkRead() {
        val store = tempStore()
        store.apply(QueuedMessage(id = 1, botId = "b1", body = "a"))
        store.apply(QueuedMessage(id = 2, botId = "b1", body = "b"))
        assertEquals(2, store.unreadCount("b1"))
        store.markRead("b1")
        assertEquals(0, store.unreadCount("b1"))
    }

    @Test fun markReadReturnsUnreadNotifications() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "a"), "n1")
        store.apply(QueuedMessage(2, "b1", body = "b"))
        assertEquals(listOf("n1"), store.markRead("b1"))
        assertEquals(emptyList<String>(), store.markRead("b1"))
        assertEquals(0, store.unreadTotal())
    }

    @Test fun deleteMessageAndBot() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "a"), "n1")
        assertEquals("n1", store.deleteMessage(1))
        assertNull(store.deleteMessage(1))
        store.apply(QueuedMessage(2, "b1", body = "b"))
        store.deleteBot("b1")
        assertNull(store.bot("b1"))
        assertTrue(store.messages("b1").isEmpty())
    }

    @Test fun replaceBotsDropsGoneBots() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b2", body = "x"))
        store.setMuted("b1", true)
        store.replaceBots(listOf(Bot("b1", "改名")))
        assertNull(store.bot("b2"))
        assertTrue(store.messages("b2").isEmpty())
        assertEquals("改名", store.bot("b1")?.name)
        assertTrue("local flags survive", store.isMuted("b1"))
        store.replaceBots(emptyList())
        assertNull(store.bot("b1"))
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
            replaceBots(listOf(Bot("b1", "b")))
            apply(QueuedMessage(5, "b1", body = "kept"))
            close()
        }
        assertEquals("kept", LocalStore(JdbcSql(path)).messages("b1").first().body)
    }
}
