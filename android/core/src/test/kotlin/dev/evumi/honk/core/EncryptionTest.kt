package dev.evumi.honk.core

import java.io.File
import java.security.SecureRandom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

// The same cases as ios/HonkKit/Tests/HonkKitTests/EncryptionTests.swift, against
// the vector shared with the Go client (app/src/e2e.vector.json).
class EncryptionTest {
    private val placeholder = "无法解密的通知"

    private val vector: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("honk.e2e.vector") ?: error("honk.e2e.vector is not set")).readText(),
    ).jsonObject
    private val vKey = Seal.parseKey(vector.getValue("key").jsonPrimitive.content)!!
    private val vAad = vector.getValue("aad").jsonPrimitive.content
    private val vPlain = vector.getValue("plaintext").jsonPrimitive.content
    private val vCipher = vector.getValue("ciphertext").jsonPrimitive.content

    private fun opener(keys: MemoryBotKeys) = MessageOpener(keys, placeholder)

    private fun sealed(key: ByteArray, aad: String = "b1", build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        Seal.seal(buildJsonObject(build).toString().toByteArray(), key, aad)

    @Test fun opensTheSharedVector() {
        assertEquals(vPlain, String(Seal.open(vCipher, vKey, vAad), Charsets.UTF_8))
        assertThrows(Seal.Failure::class.java) { Seal.open(vCipher, vKey, "other") }
        assertThrows(Seal.Failure::class.java) { Seal.open(vCipher, Seal.generateKey(), vAad) }
    }

    @Test fun sealsToTheSharedVector() {
        val nonce = ByteArray(12) { (0xa0 + it).toByte() }
        assertEquals(vCipher, Seal.seal(vPlain.toByteArray(), vKey, vAad, nonce))
    }

    @Test fun rejectsBadInput() {
        val key = Seal.generateKey()
        assertThrows(Seal.Failure::class.java) { Seal.open("AAAA", ByteArray(16), "a") }
        assertThrows(Seal.Failure::class.java) { Seal.open("!!!", key, "a") }
        assertThrows(Seal.Failure::class.java) { Seal.open("AAAA", key, "a") }
        val raw = Seal.decode(Seal.seal("hi".toByteArray(), key, "a"))!!
        raw[raw.size - 1] = (raw[raw.size - 1].toInt() xor 1).toByte()
        assertThrows(Seal.Failure::class.java) { Seal.open(Seal.encode(raw), key, "a") }
    }

    @Test fun keyText() {
        val k = Seal.generateKey()
        assertEquals(32, k.size)
        val text = Seal.encode(k)
        assertTrue(!text.contains('=') && !text.contains('+') && !text.contains('/'))
        assertArrayEquals(k, Seal.parseKey(text))
        assertArrayEquals(k, Seal.parseKey(java.util.Base64.getEncoder().encodeToString(k)))
        assertNull(Seal.parseKey("AAAA"))
    }

    @Test fun opensAMessage() {
        val keys = MemoryBotKeys()
        val key = Seal.generateKey()
        keys.save("b1", key)
        val ct = sealed(key) {
            put("title", "部署成功"); put("body", "已上线"); put("html", "<p>{{s}}</p>"); put("data", """{"s":"ok"}""")
            put("url", "https://example.com/a"); put("copy", "dep_1"); put("icon", "https://example.com/i.png"); put("image", "https://example.com/p.jpg")
        }
        val out = opener(keys).open(QueuedMessage(5, "b1", level = "passive", group = "ci", ciphertext = ct, collapseId = "dep", date = 9))!!
        assertEquals("部署成功", out.title)
        assertEquals("已上线", out.body)
        assertEquals("<p>{{s}}</p>", out.html)
        assertEquals("""{"s":"ok"}""", out.data)
        assertEquals("https://example.com/a", out.url)
        assertEquals("dep_1", out.copy)
        assertEquals("https://example.com/i.png", out.icon)
        assertEquals("https://example.com/p.jpg", out.image)
        assertEquals("", out.ciphertext)
        assertEquals("plaintext fields stay", listOf("passive", "ci", "dep", 9L), listOf(out.level, out.group, out.collapseId, out.date))

        val store = tempStore()
        store.apply(out)
        assertEquals("已上线", store.message(5)?.body)
    }

    @Test fun dataMayBeAnObject() {
        val keys = MemoryBotKeys()
        val key = Seal.generateKey()
        keys.save("b1", key)
        val ct = sealed(key) { put("body", "b"); put("html", "<p>x</p>"); put("data", buildJsonObject { put("n", 1) }) }
        assertEquals("""{"n":1}""", opener(keys).open(QueuedMessage(1, "b1", ciphertext = ct))?.data)
    }

    @Test fun plaintextWithoutAKeyPassesThrough() {
        val m = QueuedMessage(1, "b1", body = "plain", date = 3)
        assertEquals(m, opener(MemoryBotKeys()).open(m))
        val d = QueuedMessage(2, "b1", QueuedMessage.Kind.DELETE, targetId = 1)
        assertEquals(d, opener(MemoryBotKeys()).open(d))
    }

    @Test fun undecryptableMessageBecomesAPlaceholder() {
        val keys = MemoryBotKeys()
        val ct = sealed(Seal.generateKey()) { put("body", "secret") }
        val m = QueuedMessage(7, "b1", level = "active", group = "g", ciphertext = ct, collapseId = "c", date = 4)

        // No key on this device.
        var out = opener(keys).open(m)!!
        assertEquals(placeholder, out.body)
        assertTrue(out.title.isEmpty() && out.html.isEmpty() && out.ciphertext.isEmpty())
        assertEquals(listOf(7L, "g", "c", 4L), listOf(out.id, out.group, out.collapseId, out.date))
        // A different key.
        keys.save("b1", Seal.generateKey())
        assertEquals(placeholder, opener(keys).open(m)!!.body)
        // The bot id is the AAD: another bot's ciphertext does not open.
        val key = Seal.generateKey()
        keys.save("b1", key)
        val other = sealed(key, aad = "b2") { put("body", "x") }
        assertEquals(placeholder, opener(keys).open(QueuedMessage(8, "b1", ciphertext = other))!!.body)
        // Not JSON.
        val junk = Seal.seal("not json".toByteArray(), key, "b1")
        assertEquals(placeholder, opener(keys).open(QueuedMessage(9, "b1", ciphertext = junk))!!.body)

        val store = tempStore()
        store.apply(opener(keys).open(m)!!)
        assertEquals(placeholder, store.message(7)?.body)
    }

    @Test fun plaintextForABotWithAKeyIsNotTrusted() {
        val keys = MemoryBotKeys()
        keys.save("b1", Seal.generateKey())
        assertEquals(placeholder, opener(keys).open(QueuedMessage(1, "b1", body = "from the gateway", date = 1))!!.body)
        assertNull(opener(keys).open(QueuedMessage(2, "b1", QueuedMessage.Kind.EDIT, targetId = 1, data = "x")))
        assertEquals(QueuedMessage.Kind.DELETE, opener(keys).open(QueuedMessage(3, "b1", QueuedMessage.Kind.DELETE, targetId = 1))!!.kind)
        assertEquals("ok", opener(keys).open(QueuedMessage(4, "b2", body = "ok"))!!.body)
    }

    @Test fun editsCarryDataInTheCiphertext() {
        val keys = MemoryBotKeys()
        val key = Seal.generateKey()
        keys.save("b1", key)
        val edit = QueuedMessage(2, "b1", QueuedMessage.Kind.EDIT, targetId = 1, ciphertext = sealed(key) { put("data", """{"s":"已回滚"}""") })
        assertEquals("""{"s":"已回滚"}""", opener(keys).open(edit)?.data)
        val bad = QueuedMessage(3, "b1", QueuedMessage.Kind.EDIT, targetId = 1, ciphertext = sealed(Seal.generateKey()) { put("data", "x") })
        assertNull(opener(keys).open(bad))
        val big = QueuedMessage(4, "b1", QueuedMessage.Kind.EDIT, targetId = 1, ciphertext = sealed(key) { put("data", "a".repeat(1025)) })
        assertNull(opener(keys).open(big))
    }

    @Test fun limitsAreEnforcedAfterDecrypting() {
        val keys = MemoryBotKeys()
        val key = Seal.generateKey()
        keys.save("b1", key)
        fun open(build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): QueuedMessage =
            opener(keys).open(QueuedMessage(1, "b1", ciphertext = sealed(key, build = build)))!!

        val long = open { put("title", "标".repeat(300)); put("body", "x".repeat(5000)); put("copy", "c".repeat(5000)) }
        assertEquals(listOf(256, 4096, 4096), listOf(long.title, long.body, long.copy).map { it.codePointCount(0, it.length) })
        // Characters past the BMP count once and are never cut in half.
        val astral = open { put("body", "😀".repeat(4100)) }
        assertEquals(4096, astral.body.codePointCount(0, astral.body.length))

        val links = open { put("body", "b"); put("url", "javascript:alert(1)"); put("icon", "http://example.com/i.png"); put("image", "http://example.com/p.png") }
        assertTrue("url must be http(s), icon and image https", links.url.isEmpty() && links.icon.isEmpty() && links.image.isEmpty())
        assertEquals("http://example.com/x", open { put("body", "b"); put("url", "http://example.com/x") }.url)
        assertEquals("", open { put("body", "b"); put("url", "ftp://example.com/x") }.url)
        assertEquals("", open { put("body", "b"); put("url", "https:///nohost") }.url)

        // A card: raw size, compressed size and data are checked; an invalid card is dropped, the body stays.
        val fine = open { put("body", "b"); put("html", "<p>ok</p>"); put("data", "{}") }
        assertEquals(listOf("<p>ok</p>", "{}"), listOf(fine.html, fine.data))
        val tooRaw = open { put("body", "keep me"); put("html", "<p>" + "a".repeat(33 * 1024) + "</p>"); put("data", "{}") }
        assertTrue(tooRaw.html.isEmpty() && tooRaw.data.isEmpty())
        assertEquals("keep me", tooRaw.body)
        val rnd = SecureRandom()
        val incompressible = (0 until 2000).joinToString("") { java.lang.Long.toString(rnd.nextLong() ushr 1, 36) }
        assertTrue(incompressible.length < ContentLimits.HTML_RAW)
        val tooPacked = open { put("body", "keep me"); put("html", "<p>$incompressible</p>") }
        assertTrue(tooPacked.html.isEmpty())
        assertEquals("keep me", tooPacked.body)
        val bigData = open { put("body", "b"); put("html", "<p>x</p>"); put("data", "d".repeat(1025)) }
        assertTrue(bigData.html.isEmpty() && bigData.data.isEmpty())
    }

    @Test fun compressedSizeMatchesZlib() {
        val size = ContentLimits.compressedSize("0".repeat(10_000))
        assertTrue(size in 7..59)
    }

    @Test fun syncDecryptsSealedItems() {
        val keys = MemoryBotKeys()
        val key = Seal.generateKey()
        keys.save("b1", key)
        val ct = sealed(key) { put("body", "sealed body") }
        val store = tempStore()
        val gw = FakeGateway { _, path, _ ->
            when {
                path.startsWith("v1/sync?cursor=0") -> FakeGateway.ok(
                    """{"messages":[
                        {"message_id":1,"bot_id":"b1","kind":"message","ciphertext":"$ct","date":1},
                        {"message_id":2,"bot_id":"b1","kind":"edit","target_id":1,"data":"forged","date":2}
                       ],"cursor":2,"has_more":false}""",
                )
                path == "v1/ack" -> FakeGateway.ok("""{"acked":2}""")
                else -> FakeGateway.fail(404, "Not Found")
            }
        }
        val out = SyncEngine(ApiClient(FakeGateway.BASE, "s", gw), store, opener(keys)).run()
        assertEquals("the plaintext edit for a keyed bot is skipped", 1, out.applied)
        assertEquals("sealed body", store.message(1)?.body)
        assertEquals("", store.message(1)?.data)
        assertEquals(2L, store.syncCursor)
        keys.remove("b1")
        assertNull(keys.key("b1"))
        assertNotNull(Seal.parseKey(Seal.encode(key)))
    }
}
