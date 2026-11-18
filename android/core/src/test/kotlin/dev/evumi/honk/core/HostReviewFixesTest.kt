package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// Review fixes shared with ios/HonkKit/Tests/HonkKitTests/ReviewFixesTests.swift.
class HostReviewFixesTest {
    private fun bot(id: String, encrypted: Boolean, wrapped: String = "") = Bot(id, id, encrypted = encrypted, keyWrapped = wrapped)

    @Test fun reconcileDropsTheKeyOfABotThatIsNotEncryptedAnymore() {
        val ring = KeyRing(MemoryBotKeys(), MemoryGroupKey())
        ring.keys.save("b1", Seal.generateKey())
        ring.keys.save("b2", Seal.generateKey())
        ring.reconcile(listOf(bot("b1", encrypted = false), bot("b2", encrypted = true))) { _, _ -> }
        assertNull(ring.keys.key("b1"))
        assertNotNull(ring.keys.key("b2"))
    }

    @Test fun aNoOpReconcileDoesNotMakeAGroupKey() {
        val ring = KeyRing(MemoryBotKeys(), MemoryGroupKey())
        assertNull(ring.wrapped("b1"))
        ring.reconcile(listOf(bot("b1", encrypted = true))) { _, _ -> }
        assertNull(ring.group.groupKey())
        // With a local key the patch is sent, and only then the group key exists.
        ring.keys.save("b1", Seal.generateKey())
        assertNull("no group key, no wrap", ring.wrapped("b1"))
        var patched = 0
        ring.reconcile(listOf(bot("b1", encrypted = true))) { _, _ -> patched++ }
        assertEquals(1, patched)
        assertNotNull(ring.group.groupKey())
    }

    @Test fun aPlaceholderIsRepairedByRealContent() {
        val store = tempStore()
        val opener = MessageOpener(MemoryBotKeys().also { it.save("b1", Seal.generateKey()) }, "无法解密")
        val failed = opener.open(QueuedMessage(1, "b1", body = "forged", date = 5))!!
        assertTrue(failed.placeholder)
        store.apply(failed, "m1")
        assertEquals("无法解密", store.message(1)?.body)
        // The same placeholder again changes nothing; real content replaces it.
        store.apply(failed, "m1")
        store.apply(QueuedMessage(1, "b1", title = "T", body = "real", html = "<b>x</b>", data = "d", date = 5))
        val m = store.message(1)!!
        assertEquals("real", m.body)
        assertEquals("T", m.title)
        assertEquals("<b>x</b>", m.html)
        // Once real, a later placeholder (a key lost meanwhile) does not clobber it.
        store.apply(failed)
        assertEquals("real", store.message(1)?.body)
        assertEquals("d", store.message(1)?.data)
    }

    @Test fun importRepairsPlaceholdersAndAppliesLimits() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "无法解密", date = 1, placeholder = true))
        val big = "x".repeat(ContentLimits.DATA + 1)
        val items = listOf(
            QueuedMessage(1, "b1", body = "restored", date = 1),
            QueuedMessage(
                2, "b1", body = "b".repeat(ContentLimits.BODY + 10), url = "javascript:alert(1)", icon = "http://insecure/x.png",
                image = "https://ok.example/i.png", html = "<p>card</p>", data = big, date = 2,
            ),
        )
        val summary = store.importMessages(items)
        assertEquals(2, summary.imported)
        assertEquals("restored", store.message(1)?.body)
        val m = store.message(2)!!
        assertEquals(ContentLimits.BODY, m.body.length)
        assertEquals("", m.url)
        assertEquals("", m.icon)
        assertEquals("https://ok.example/i.png", m.image)
        assertEquals("a card whose data is too big is dropped", "", m.html)
        assertEquals("", m.data)
    }

    @Test fun archiveDecodeAppliesLimits() {
        val line = """{"message_id":3,"bot_id":"b1","kind":"message","body":"hi","url":"ftp://x/y","image":"http://x/y.png"}"""
        val m = MessageArchive.decode(line).messages.single()
        assertEquals("", m.url)
        assertEquals("", m.image)
    }

    @Test fun pruningKeepsStoredBotsOnly() {
        val store = tempStore()
        val tokens = MemoryTokens(mutableMapOf("b1" to "b1:s", "gone" to "gone:s", "4" to "4:s"))
        val keys = MemoryBotKeys().also { it.save("b2", Seal.generateKey()); it.save("gone", Seal.generateKey()) }
        // A legacy bot still pending its rename is stored (replaceBots keeping =), so it stays.
        store.saveBot(Bot("4", "old"))
        SecretPruning.prune(store, tokens, keys)
        assertEquals(setOf("b1", "4"), tokens.map.keys)
        assertEquals(listOf("b2"), keys.ids())
    }

    @Test fun syncRestartsFromZeroWhenTheGatewayAsksForReset() {
        val store = tempStore()
        store.syncCursor = 50
        val seen = mutableListOf<String>()
        val gw = FakeGateway { method, path, _ ->
            seen += "$method $path"
            when {
                path == "v1/sync?cursor=50&limit=100" -> FakeGateway.ok("""{"messages":[],"cursor":50,"has_more":false,"reset":true}""")
                path == "v1/sync?cursor=0&limit=100" -> FakeGateway.ok(
                    """{"messages":[{"message_id":7,"bot_id":"b1","kind":"message","body":"merged","date":9}],"cursor":60,"has_more":false}""",
                )
                path == "v1/ack" -> FakeGateway.ok("""{"acked":1}""")
                else -> FakeGateway.fail(404, "Not Found")
            }
        }
        val out = SyncEngine(ApiClient(FakeGateway.BASE, "s", gw), store, plainOpener).run()
        assertEquals(1, out.applied)
        assertEquals("merged", store.message(7)?.body)
        assertEquals(60L, store.syncCursor)
        assertEquals(listOf("GET v1/sync?cursor=50&limit=100", "GET v1/sync?cursor=0&limit=100", "POST v1/ack"), seen)
    }

    @Test fun anOlderGatewayWithoutResetStillSyncs() {
        val page = ApiClient.JSON.decodeFromString(ApiClient.SyncPage.serializer(), """{"messages":[],"cursor":3}""")
        assertFalse(page.reset)
    }

    @Test fun placeholderFlagIsNeverOnTheWire() {
        val encoded = ApiClient.JSON.encodeToString(QueuedMessage.serializer(), QueuedMessage(1, "b1", placeholder = true))
        assertFalse(encoded.contains("placeholder"))
    }

    private fun ring() = KeyRing(MemoryBotKeys(), MemoryGroupKey())

    @Test fun enablingAnUnencryptedBotMakesAndPublishesAKey() {
        val r = ring()
        var sent: String? = null
        val k = r.enable(bot("b1", false)) { sent = it }
        assertArrayEquals(k, r.keys.key("b1"))
        assertArrayEquals(k, KeyWrap.unwrap(sent!!, r.group.groupKey()!!, "b1"))
    }

    @Test fun aFailedPublishLeavesNoKey() {
        val r = ring()
        assertThrows(IllegalStateException::class.java) { r.enable(bot("b1", false)) { error("offline") } }
        assertNull(r.keys.key("b1"))
    }

    @Test fun enablingAnEncryptedBotWithoutItsKeyWaitsInsteadOfReplacingTheGroupsKey() {
        val creator = ring()
        creator.keys.save("b1", Seal.generateKey())
        val wrapped = creator.wrapped("b1", createGroupKey = true)!!
        val fresh = ring()
        var patched = 0
        assertThrows(WaitingForKeyException::class.java) { fresh.enable(bot("b1", true, wrapped)) { patched++ } }
        assertEquals(0, patched)
        assertNull(fresh.keys.key("b1"))
        val paired = KeyRing(MemoryBotKeys(), MemoryGroupKey(creator.group.groupKey()))
        val k = paired.enable(bot("b1", true, wrapped)) { patched++ }
        assertArrayEquals(creator.keys.key("b1"), k)
        assertEquals(0, patched)
    }

    @Test fun resetKeepsTheOldKeyWhenThePatchFails() {
        val r = ring()
        val old = Seal.generateKey()
        r.keys.save("b1", old)
        assertThrows(IllegalStateException::class.java) { r.reset("b1") { error("offline") } }
        assertArrayEquals(old, r.keys.key("b1"))
        val k = r.reset("b1") { }
        assertFalse(old.contentEquals(k))
        assertArrayEquals(k, r.keys.key("b1"))
    }

    @Test fun theEncryptedFlagIsStored() {
        val store = tempStore()
        store.replaceBots(listOf(Bot("b1", "部署", encrypted = true), Bot("b2", "告警")))
        assertTrue(store.bot("b1")!!.encrypted)
        assertTrue(store.chats().first { it.bot.id == "b1" }.bot.encrypted)
        store.setEncrypted("b1", false)
        assertFalse(store.bot("b1")!!.encrypted)
    }

    @Test fun aSlotOpensOncePerInterval() {
        val store = tempStore()
        assertTrue(store.claimSlot("key-refresh", 1000, now = 10_000))
        assertFalse(store.claimSlot("key-refresh", 1000, now = 10_500))
        assertTrue(store.claimSlot("other", 1000, now = 10_500))
        assertTrue(store.claimSlot("key-refresh", 1000, now = 11_000))
    }
}
