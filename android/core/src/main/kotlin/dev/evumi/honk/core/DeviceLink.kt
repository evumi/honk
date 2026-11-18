package dev.evumi.honk.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Pairing a new phone with the device group (docs/DESIGN.zh-CN.md, 3.2). The
// gateway never sees the pairing code: both phones derive from it a `link_id`
// (what the gateway files the bundle under) and a `wrap_key` (which seals the
// bundle). The same derivation lives in ios/HonkKit's DeviceLink.swift; the
// vectors in docs/link-vectors.json are tested on both.

/** The pairing code: 16 random bytes, shown as 26 characters of Crockford base32 (no I, L, O, U), grouped in fours. */
object PairingCode {
    const val BYTES = 16
    const val LENGTH = 26
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    fun generate(): ByteArray = ByteArray(BYTES).also { SecureRandom().nextBytes(it) }

    /** The 26 characters of [bytes] (no grouping). */
    fun encode(bytes: ByteArray): String {
        val out = StringBuilder()
        var acc = 0
        var bits = 0
        for (b in bytes) {
            acc = (acc shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                out.append(ALPHABET[(acc shr (bits - 5)) and 31])
                bits -= 5
            }
            acc = acc and ((1 shl bits) - 1)
        }
        if (bits > 0) out.append(ALPHABET[(acc shl (5 - bits)) and 31])
        return out.toString()
    }

    /** `ABCD-EFGH-…`: groups of four with dashes, for reading out and typing. */
    fun display(bytes: ByteArray): String = encode(bytes).chunked(4).joinToString("-")

    /**
     * Reads what a person typed or pasted: case, spaces and dashes do not
     * matter, and O reads as 0, I and L as 1. Null when it is not a code (wrong
     * length, a character outside the alphabet, or non-zero padding bits).
     */
    fun decode(text: String): ByteArray? {
        val chars = text.uppercase().filter { !it.isWhitespace() && it != '-' }
            .map { when (it) { 'O' -> '0'; 'I', 'L' -> '1'; else -> it } }
        if (chars.size != LENGTH) return null
        val out = ArrayList<Byte>()
        var acc = 0
        var bits = 0
        for (c in chars) {
            val v = ALPHABET.indexOf(c)
            if (v < 0) return null
            acc = (acc shl 5) or v
            bits += 5
            if (bits >= 8) {
                out += ((acc shr (bits - 8)) and 0xff).toByte()
                bits -= 8
                acc = acc and ((1 shl bits) - 1)
            }
        }
        // 26 × 5 = 130 bits: the last two are padding and must be zero.
        if (bits != 2 || acc and 3 != 0 || out.size != BYTES) return null
        return out.toByteArray()
    }
}

/** Key derivation and sealing for the pairing bundle. */
object LinkCrypto {
    private val AAD = "honk link v1".toByteArray()
    private val B64 = Base64.getUrlEncoder().withoutPadding()

    /** HKDF-SHA256 (RFC 5869) with an empty salt (a block of zeros) and one 32-byte block of output. */
    private fun derive(code: ByteArray, info: String): ByteArray {
        val extract = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(ByteArray(32), "HmacSHA256")) }
        val prk = extract.doFinal(code)
        val expand = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
        expand.update(info.toByteArray())
        expand.update(1.toByte())
        return expand.doFinal()
    }

    /** What the gateway files the bundle under: base64url (no padding) of 32 derived bytes. */
    fun linkId(code: ByteArray): String = base64url(derive(code, "honk link id"))

    fun wrapKey(code: ByteArray): ByteArray = derive(code, "honk link key")

    /**
     * `nonce(12) || ciphertext || tag(16)` of AES-256-GCM, as base64url without
     * padding. The nonce is random unless a test passes one.
     */
    fun seal(plaintext: ByteArray, wrapKey: ByteArray, nonce: ByteArray? = null): String {
        val n = nonce ?: ByteArray(12).also { SecureRandom().nextBytes(it) }
        require(n.size == 12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(wrapKey, "AES"), GCMParameterSpec(128, n))
        c.updateAAD(AAD)
        return base64url(n + c.doFinal(plaintext))
    }

    /** Opens what [seal] made. Throws [LinkException.Malformed] when the key is wrong or the text was changed. */
    fun open(sealed: String, wrapKey: ByteArray): ByteArray {
        val blob = fromBase64url(sealed)
        if (blob == null || blob.size < 12 + 16) throw LinkException.Malformed()
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(wrapKey, "AES"), GCMParameterSpec(128, blob, 0, 12))
            c.updateAAD(AAD)
            c.doFinal(blob, 12, blob.size - 12)
        } catch (e: java.security.GeneralSecurityException) {
            throw LinkException.Malformed()
        }
    }

    fun base64url(b: ByteArray): String = B64.encodeToString(b)

    fun fromBase64url(s: String): ByteArray? = try {
        Base64.getUrlDecoder().decode(s)
    } catch (e: IllegalArgumentException) {
        null
    }
}

/** Why pairing failed; the messages are shown as they are. */
sealed class LinkException(message: String) : Exception(message) {
    class Malformed : LinkException("配对数据无法读取")
    class BadCode : LinkException("配对码格式不对：应是 26 个字母和数字")
    class TooLarge : LinkException("配对数据太大，请先删掉一些 bot")

    /** The gateway does not know the code: wrong, expired or already used. */
    class UnknownCode : LinkException("配对码不对、已过期或已用过")

    /** Too many attempts from this address. */
    class RateLimited : LinkException("尝试次数太多，请稍后再试")
}

/**
 * What the old phone hands the new one, sealed with the wrap key. JSON:
 * `{"v":1,"tokens":{botId:token},"keys":{botId:base64url},"group_key":base64url}`.
 * `keys` (a bot's end-to-end key) and `group_key` (the group's encryption
 * key) are reserved for the encryption phase and absent until then.
 */
@Serializable
data class LinkBundle(
    val v: Int = 1,
    val tokens: Map<String, String> = emptyMap(),
    val keys: Map<String, String>? = null,
    @SerialName("group_key") val groupKey: String? = null,
) {
    fun seal(code: ByteArray): String {
        val plain = JSON.encodeToString(serializer(), copy(keys = keys?.takeIf { it.isNotEmpty() })).toByteArray()
        val sealed = LinkCrypto.seal(plain, LinkCrypto.wrapKey(code))
        if (sealed.length > MAX_SEALED_BYTES) throw LinkException.TooLarge()
        return sealed
    }

    companion object {
        /** The text the gateway stores (at most 16 KB). */
        const val MAX_SEALED_BYTES = 16 shl 10

        // `v` is always written; null keys and group_key are left out; fields this app does not know are ignored.
        private val JSON = Json { encodeDefaults = true; explicitNulls = false; ignoreUnknownKeys = true }

        fun open(sealed: String, code: ByteArray): LinkBundle {
            val plain = LinkCrypto.open(sealed, LinkCrypto.wrapKey(code))
            return try {
                JSON.decodeFromString(serializer(), String(plain))
            } catch (e: Exception) {
                throw LinkException.Malformed()
            }
        }
    }
}

/** Making and using a pairing code: what the two phones do around the gateway's `POST /v1/links` and `POST /v1/links/claim`. */
object DeviceLinking {
    /** [code] is in groups of four, to show and copy; [expiresAt] is Unix milliseconds. */
    data class Created(val code: String, val expiresAt: Long)

    /**
     * Seals this phone's bot tokens (and, once there are any, the bots'
     * end-to-end keys) with a new code and files them on the gateway. [keys]
     * and [groupKey] come from the encryption storage when it exists.
     */
    fun create(
        api: ApiClient, store: LocalStore, tokens: BotTokenStore,
        keys: Map<String, String> = emptyMap(), groupKey: String? = null, nowMs: Long = System.currentTimeMillis(),
    ): Created {
        val code = PairingCode.generate()
        val known = store.botIds().mapNotNull { id -> tokens.token(id)?.let { id to it } }.toMap()
        val bundle = LinkBundle(tokens = known, keys = keys, groupKey = groupKey).seal(code)
        val seconds = api.createLink(LinkCrypto.linkId(code), bundle)
        return Created(PairingCode.display(code), nowMs + seconds * 1000L)
    }

    /**
     * Joins this phone to the group that made the code. The gateway merges the
     * two groups; this stores the tokens it was given and starts the sync cursor
     * over, so the merged group's queue arrives. The caller then refreshes (bot
     * list, sync) and stores the bundle's `keys` / `groupKey`.
     */
    fun claim(text: String, api: ApiClient, store: LocalStore, tokens: BotTokenStore): LinkBundle {
        val code = PairingCode.decode(text) ?: throw LinkException.BadCode()
        val sealed = try {
            api.claimLink(LinkCrypto.linkId(code))
        } catch (e: ApiException.Gateway) {
            when (e.code) {
                404 -> throw LinkException.UnknownCode()
                429 -> throw LinkException.RateLimited()
                else -> throw e
            }
        }
        val bundle = LinkBundle.open(sealed, code)
        bundle.tokens.forEach { (id, token) -> tokens.save(id, token) }
        store.syncCursor = 0
        return bundle
    }
}
