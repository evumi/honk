package dev.evumi.honk.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// docs/link-vectors.json is shared with ios/HonkKit's DeviceLinkTests: the
// derivation and the sealed bundle must come out byte for byte the same.
class DeviceLinkTest {
    private val root: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("honk.linkVectors") ?: error("honk.linkVectors is not set")).readText(),
    ).jsonObject

    private val vectors: List<JsonObject> = root.getValue("vectors").jsonArray.map { it.jsonObject }

    private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun hexString(b: ByteArray) = b.joinToString("") { "%02x".format(it) }
    private fun JsonObject.str(k: String) = getValue(k).jsonPrimitive.content

    @Test fun theSharedVectorsMatch() {
        assertTrue(vectors.size >= 2)
        for (v in vectors) {
            val code = hex(v.str("code_hex"))
            assertEquals(v.str("code"), PairingCode.encode(code))
            assertArrayEquals(code, PairingCode.decode(v.str("code")))
            assertEquals(v.str("link_id"), LinkCrypto.linkId(code))
            val key = LinkCrypto.wrapKey(code)
            assertEquals(v.str("wrap_key_hex"), hexString(key))
            val plain = v.str("plaintext").toByteArray()
            assertEquals(v.str("sealed"), LinkCrypto.seal(plain, key, hex(v.str("nonce_hex"))))
            assertArrayEquals(plain, LinkCrypto.open(v.str("sealed"), key))
        }
    }

    @Test fun theLastVectorIsAFullBundle() {
        val v = vectors.last()
        val b = LinkBundle.open(v.str("sealed"), hex(v.str("code_hex")))
        assertEquals(2, b.tokens.size)
        assertTrue(b.tokens.getValue("bQ7mN2pR").startsWith("bQ7mN2pR:"))
        assertNotNull(b.keys?.get("aZ3kQ9xT"))
        assertNotNull(b.groupKey)
    }

    @Test fun codesAreNormalisedAndChecked() {
        for (n in root.getValue("normalize").jsonArray.map { it.jsonObject }) {
            val got = PairingCode.decode(n.str("input"))
            assertNotNull(n.str("input"), got)
            assertArrayEquals(PairingCode.decode(n.str("code")), got)
        }
        for (bad in (root.getValue("invalid") as JsonArray).map { it.jsonPrimitive.content }) {
            assertNull("'$bad'", PairingCode.decode(bad))
        }
    }

    @Test fun generatedCodesRoundTripAndDisplayInGroups() {
        val seen = mutableSetOf<String>()
        repeat(50) {
            val code = PairingCode.generate()
            assertEquals(16, code.size)
            val text = PairingCode.encode(code)
            assertEquals(26, text.length)
            assertArrayEquals(code, PairingCode.decode(text))
            assertArrayEquals(code, PairingCode.decode(PairingCode.display(code).lowercase()))
            seen += text
        }
        assertEquals(50, seen.size)
        assertEquals("000G-40R4-0M30-E209-185G-R38E-1W", PairingCode.display(ByteArray(16) { it.toByte() }))
    }

    @Test fun aBundleSealsAndOpensWithItsCodeOnly() {
        val code = PairingCode.generate()
        val bundle = LinkBundle(tokens = mapOf("aZ3kQ9xT" to "aZ3kQ9xT:secret"), keys = mapOf("aZ3kQ9xT" to "a2V5"), groupKey = "Z2s")
        val sealed = bundle.seal(code)
        assertTrue(sealed.length < LinkBundle.MAX_SEALED_BYTES)
        assertEquals(bundle, LinkBundle.open(sealed, code))
        assertThrows(LinkException.Malformed::class.java) { LinkBundle.open(sealed, PairingCode.generate()) }
        val chars = sealed.toCharArray()
        chars[chars.size - 3] = if (chars[chars.size - 3] == 'A') 'B' else 'A'
        assertThrows(LinkException.Malformed::class.java) { LinkBundle.open(String(chars), code) }
        assertThrows(LinkException.Malformed::class.java) { LinkBundle.open("AAAA", code) }
    }

    @Test fun theBundleFormatIsTheDocumentedJson() {
        val code = PairingCode.generate()
        fun plain(b: LinkBundle) = Json.parseToJsonElement(String(LinkCrypto.open(b.seal(code), LinkCrypto.wrapKey(code)))).jsonObject
        assertEquals(setOf("v", "tokens"), plain(LinkBundle(tokens = mapOf("b" to "b:t"))).keys)
        assertEquals(setOf("v", "tokens", "keys", "group_key"), plain(LinkBundle(keys = mapOf("b" to "k"), groupKey = "g")).keys)
        assertEquals("1", plain(LinkBundle()).str("v"))
        // A bundle from a newer app with fields this one does not know still opens.
        val newer = LinkCrypto.seal("""{"v":2,"tokens":{"b":"b:t"},"future":1}""".toByteArray(), LinkCrypto.wrapKey(code))
        assertEquals(mapOf("b" to "b:t"), LinkBundle.open(newer, code).tokens)
    }

    @Test fun aBundleOverTheGatewayLimitIsRefused() {
        val tokens = (0 until 400).associate { "b$it" to "x".repeat(60) }
        assertThrows(LinkException.TooLarge::class.java) { LinkBundle(tokens = tokens).seal(PairingCode.generate()) }
    }

    @Test fun aCodeMadeOnOnePhoneOpensOnTheOther() {
        val old = tempStore()
        old.saveBot(Bot("aZ3kQ9xT", "部署", "", "active", 1, 1))
        old.saveBot(Bot("bQ7mN2pR", "no token here", "", "active", 2, 2))
        var posted: Map<String, String> = emptyMap()
        val create = FakeGateway { _, path, body ->
            if (path == "v1/links") {
                posted = Json.parseToJsonElement(body!!).jsonObject.mapValues { it.value.jsonPrimitive.content }
                FakeGateway.ok("""{"expires_in":600}""")
            } else FakeGateway.fail(404, "Not Found")
        }
        val created = DeviceLinking.create(ApiClient(FakeGateway.BASE, "s", create), old, MemoryTokens(mutableMapOf("aZ3kQ9xT" to "aZ3kQ9xT:secret")), nowMs = 1_700_000_000_000)
        assertEquals(1_700_000_600_000, created.expiresAt)
        assertEquals(32, created.code.length)
        val code = PairingCode.decode(created.code)!!
        assertEquals(LinkCrypto.linkId(code), posted["link_id"])
        assertFalse("the gateway never gets anything but the derived id", created.code in posted.values)
        assertEquals(mapOf("aZ3kQ9xT" to "aZ3kQ9xT:secret"), LinkBundle.open(posted.getValue("bundle"), code).tokens)

        // The new phone claims it, typed in lowercase with spaces.
        val new = tempStore()
        new.syncCursor = 42
        val claimed = mutableListOf<String>()
        val claim = FakeGateway { _, path, body ->
            claimed += body!!
            if (path == "v1/links/claim") FakeGateway.ok("""{"bundle":"${posted["bundle"]}"}""") else FakeGateway.fail(404, "Not Found")
        }
        val tokens = MemoryTokens()
        val got = DeviceLinking.claim(created.code.lowercase().replace('-', ' '), ApiClient(FakeGateway.BASE, "n", claim), new, tokens)
        assertEquals(mapOf("aZ3kQ9xT" to "aZ3kQ9xT:secret"), got.tokens)
        assertEquals(got.tokens, tokens.map)
        assertEquals("the merged group's queue is fetched from the start", 0L, new.syncCursor)
        assertTrue(claimed.single().contains(posted.getValue("link_id")))
    }

    @Test fun claimErrors() {
        val store = tempStore()
        val tokens = MemoryTokens()
        val valid = "000G-40R4-0M30-E209-185G-R38E-1W"
        fun api(code: Int, text: String) = ApiClient(FakeGateway.BASE, "s", FakeGateway { _, _, _ -> FakeGateway.fail(code, text) })
        assertThrows(LinkException.BadCode::class.java) { DeviceLinking.claim("nope", api(404, "x"), store, tokens) }
        assertThrows(LinkException.UnknownCode::class.java) { DeviceLinking.claim(valid, api(404, "Not Found"), store, tokens) }
        assertThrows(LinkException.RateLimited::class.java) { DeviceLinking.claim(valid, api(429, "Too Many Requests"), store, tokens) }
        assertThrows(ApiException.Gateway::class.java) { DeviceLinking.claim(valid, api(400, "Bad Request"), store, tokens) }
        val other = LinkBundle(tokens = mapOf("a" to "b")).seal(PairingCode.generate())
        val wrongKey = ApiClient(FakeGateway.BASE, "s", FakeGateway { _, _, _ -> FakeGateway.ok("""{"bundle":"$other"}""") })
        assertThrows(LinkException.Malformed::class.java) { DeviceLinking.claim(valid, wrongKey, store, tokens) }
        assertTrue(tokens.map.isEmpty())
    }
}
