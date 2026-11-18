package dev.evumi.honk.core

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The same cases as ios/HonkKit/Tests/HonkKitTests/KeyRingTests.swift, against
// the wrapped-key vector in app/src/e2e.vector.json.
class KeyRingTest {
    private val wrap = Json.parseToJsonElement(
        File(System.getProperty("honk.e2e.vector") ?: error("honk.e2e.vector is not set")).readText(),
    ).jsonObject.getValue("key_wrap").jsonObject
    private fun field(name: String) = wrap.getValue(name).jsonPrimitive.content

    private fun ring() = KeyRing(MemoryBotKeys(), MemoryGroupKey())

    private fun bot(id: String, wrapped: String = "", encrypted: Boolean = true) =
        Bot(id, id, encrypted = encrypted, keyWrapped = wrapped)

    @Test fun wrapsToTheSharedVector() {
        val group = Seal.parseKey(field("group_key"))!!
        val botKey = Seal.parseKey(field("bot_key"))!!
        val id = field("bot_id")
        val nonce = ByteArray(12) { (0xc0 + it).toByte() }
        assertEquals(field("wrapped"), KeyWrap.wrap(botKey, group, id, nonce))
        assertEquals(80, field("wrapped").length)
        assertArrayEquals(botKey, KeyWrap.unwrap(field("wrapped"), group, id))
        assertNull("the bot id is bound in", KeyWrap.unwrap(field("wrapped"), group, "other"))
        assertNull(KeyWrap.unwrap(field("wrapped"), Seal.generateKey(), id))
    }

    @Test fun groupKeyIsMadeOnFirstNeedAndKept() {
        val r = ring()
        assertNull(r.group.groupKey())
        val g = r.ensureGroupKey()
        assertEquals(32, g.size)
        assertArrayEquals(g, r.group.groupKey())
        assertArrayEquals(g, r.ensureGroupKey())
        assertNull("no local key, nothing to wrap", r.wrapped("b1"))
        r.keys.save("b1", Seal.generateKey())
        assertArrayEquals(r.keys.key("b1"), KeyWrap.unwrap(r.wrapped("b1")!!, g, "b1"))
    }

    @Test fun anotherDeviceUnwrapsAndFollowsAReset() {
        val a = ring()
        val key1 = Seal.generateKey()
        a.keys.save("b1", key1)
        val wrapped1 = a.wrapped("b1", createGroupKey = true)!!

        val b = KeyRing(MemoryBotKeys(), MemoryGroupKey(a.group.groupKey()))
        val patched = mutableListOf<String>()
        b.reconcile(listOf(bot("b1", wrapped1))) { id, _ -> patched += id }
        assertArrayEquals(key1, b.keys.key("b1"))
        assertTrue("nothing to send when the gateway's key opens", patched.isEmpty())

        val key2 = Seal.generateKey()
        a.keys.save("b1", key2)
        b.reconcile(listOf(bot("b1", a.wrapped("b1")!!))) { _, _ -> }
        assertArrayEquals(key2, b.keys.key("b1"))

        b.reconcile(listOf(bot("b2", wrapped1, encrypted = false))) { _, _ -> }
        assertNull(b.keys.key("b2"))
    }

    @Test fun aDeviceWithoutTheGroupKeyCannotOpenIt() {
        val a = ring()
        a.keys.save("b1", Seal.generateKey())
        val stranger = ring()
        var patched = 0
        stranger.reconcile(listOf(bot("b1", a.wrapped("b1", createGroupKey = true)!!))) { _, _ -> patched++ }
        assertNull(stranger.keys.key("b1"))
        assertEquals(0, patched)
    }

    @Test fun enablingWithoutAWrappedKeyPublishesOurs() {
        val r = ring()
        val k = Seal.generateKey()
        r.keys.save("b1", k)
        val sent = mutableMapOf<String, String>()
        r.reconcile(listOf(bot("b1"))) { id, w -> sent[id] = w }
        assertArrayEquals(k, KeyWrap.unwrap(sent.getValue("b1"), r.group.groupKey()!!, "b1"))
    }

    @Test fun aFailedPublishIsSkipped() {
        val r = ring()
        r.keys.save("b1", Seal.generateKey())
        r.keys.save("b2", Seal.generateKey())
        val sent = mutableListOf<String>()
        r.reconcile(listOf(bot("b1"), bot("b2"))) { id, _ ->
            if (id == "b1") throw java.io.IOException("offline")
            sent += id
        }
        assertEquals(listOf("b2"), sent)
    }

    @Test fun pairingCarriesTheGroupKeyAndTheBotKeys() {
        val creator = ring()
        val k1 = Seal.generateKey()
        creator.keys.save("b1", k1)
        val g = creator.ensureGroupKey()
        val bundle = LinkBundle(tokens = mapOf("b1" to "b1:secret"), keys = creator.bundleKeys(listOf("b1", "b2")), groupKey = Seal.encode(g))
        assertEquals("bots without a key are not listed", setOf("b1"), bundle.keys?.keys)

        val code = PairingCode.generate()
        val opened = LinkBundle.open(bundle.seal(code), code)
        val claimer = ring()
        claimer.adopt(opened)
        assertArrayEquals(g, claimer.group.groupKey())
        assertArrayEquals(k1, claimer.keys.key("b1"))
    }

    @Test fun aClaimerWithItsOwnGroupKeyAdoptsTheCreatorsAndRewrapsItsKeys() {
        val creator = ring()
        val k1 = Seal.generateKey()
        creator.keys.save("b1", k1)
        val bundle = LinkBundle(keys = creator.bundleKeys(listOf("b1")), groupKey = Seal.encode(creator.ensureGroupKey()))
        val wrapped1 = creator.wrapped("b1", createGroupKey = true)!!

        val claimer = ring()
        val k2 = Seal.generateKey()
        claimer.keys.save("b2", k2)
        val oldWrapped2 = claimer.wrapped("b2", createGroupKey = true)!!
        val oldGroup = claimer.group.groupKey()!!

        claimer.adopt(bundle)
        assertArrayEquals(creator.group.groupKey(), claimer.group.groupKey())
        assertFalse(oldGroup.contentEquals(claimer.group.groupKey()))

        val sent = mutableMapOf<String, String>()
        claimer.reconcile(listOf(bot("b1", wrapped1), bot("b2", oldWrapped2))) { id, w -> sent[id] = w }
        assertArrayEquals(k1, claimer.keys.key("b1"))
        assertArrayEquals(k2, claimer.keys.key("b2"))
        assertEquals("only the key the group cannot open is re-wrapped", setOf("b2"), sent.keys)
        assertArrayEquals(k2, KeyWrap.unwrap(sent.getValue("b2"), creator.group.groupKey()!!, "b2"))

        creator.reconcile(listOf(bot("b2", sent.getValue("b2")))) { _, _ -> }
        assertArrayEquals(k2, creator.keys.key("b2"))
    }

    @Test fun openerReportsWhetherItOpens() {
        val keys = MemoryBotKeys()
        val o = MessageOpener(keys, "x")
        val key = Seal.generateKey()
        val ct = Seal.seal("""{"body":"b"}""".toByteArray(), key, "b1")
        val m = QueuedMessage(1, "b1", ciphertext = ct)
        assertFalse("no key yet", o.opens(m))
        keys.save("b1", Seal.generateKey())
        assertFalse("wrong key", o.opens(m))
        keys.save("b1", key)
        assertTrue(o.opens(m))
        assertFalse("plaintext for a keyed bot", o.opens(QueuedMessage(2, "b1", body = "plain")))
        assertTrue(o.opens(QueuedMessage(3, "b9", body = "plain")))
        assertNotNull(keys.key("b1"))
    }
}
