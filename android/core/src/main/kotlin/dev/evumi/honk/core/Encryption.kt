package dev.evumi.honk.core

import java.net.URI
import java.security.SecureRandom
import java.util.Base64
import java.util.zip.Deflater
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

// End-to-end encryption, the counterpart of ios/HonkKit's Encryption.swift: a
// bot with a key gets its content as one AES-256-GCM `ciphertext`. The gateway
// stores and forwards it without reading it, so the checks it makes for
// plaintext messages happen here, after decrypting and before LocalStore.apply.

/**
 * AES-256-GCM in the wire format: the unpadded base64url text of
 * nonce (12 bytes) || ciphertext || tag (16 bytes), with the bot's short id as
 * additional authenticated data. The same format as `honk send --key`
 * (gateway/internal/client) and HonkKit's `Seal`.
 */
object Seal {
    class Failure(message: String) : Exception(message)

    private const val NONCE_SIZE = 12
    private const val TAG_SIZE = 16
    private val random = SecureRandom()

    fun generateKey(): ByteArray = ByteArray(32).also(random::nextBytes)

    /** The key as people copy it: unpadded base64url. */
    fun encode(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)

    /** Decodes base64 or base64url, padded or not; null when it is neither. */
    fun decode(text: String): ByteArray? {
        val s = text.trim().replace('+', '-').replace('/', '_').trimEnd('=')
        if (s.isEmpty()) return null
        return try {
            Base64.getUrlDecoder().decode(s)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** A 32-byte key from its text, or null. */
    fun parseKey(text: String): ByteArray? = decode(text)?.takeIf { it.size == 32 }

    /** Opens [text]; throws [Failure] when the key, the text or the bot id (AAD) is wrong. */
    fun open(text: String, key: ByteArray, aad: String): ByteArray {
        if (key.size != 32) throw Failure("bad key")
        val raw = decode(text) ?: throw Failure("not base64url")
        if (raw.size < NONCE_SIZE + TAG_SIZE) throw Failure("too short")
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_SIZE * 8, raw, 0, NONCE_SIZE))
            c.updateAAD(aad.toByteArray())
            c.doFinal(raw, NONCE_SIZE, raw.size - NONCE_SIZE)
        } catch (e: AEADBadTagException) {
            throw Failure("authentication failed")
        } catch (e: java.security.GeneralSecurityException) {
            throw Failure("authentication failed")
        }
    }

    /** Seals [plaintext]. [nonce] is for tests; leave it out to get a random one. */
    fun seal(plaintext: ByteArray, key: ByteArray, aad: String, nonce: ByteArray = ByteArray(NONCE_SIZE).also(random::nextBytes)): String {
        if (key.size != 32) throw Failure("bad key")
        require(nonce.size == NONCE_SIZE) { "the nonce is $NONCE_SIZE bytes" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_SIZE * 8, nonce))
        c.updateAAD(aad.toByteArray())
        return encode(nonce + c.doFinal(plaintext))
    }
}

/**
 * Where each bot's key comes from. A later step (keys wrapped with a group key
 * and fetched from the gateway) is another provider; the message format does
 * not change.
 */
interface BotKeyProvider {
    /** The 32-byte key of the bot, or null when the bot has none on this device. */
    fun key(botId: String): ByteArray?
}

/** Where bot keys are kept: EncryptedSharedPreferences in the app, memory in tests. */
interface BotKeyStore : BotKeyProvider {
    fun save(botId: String, key: ByteArray)
    fun remove(botId: String)

    /** The ids of the bots that have a key here; used to drop the keys of bots the gateway no longer lists. */
    fun ids(): List<String> = emptyList()

    /** Removes every bot's key (the device moved to another gateway). */
    fun removeAll()
}

/** Keys in memory, for tests. */
class MemoryBotKeys(private val map: MutableMap<String, ByteArray> = mutableMapOf()) : BotKeyStore {
    override fun key(botId: String): ByteArray? = synchronized(map) { map[botId] }
    override fun save(botId: String, key: ByteArray) { synchronized(map) { map[botId] = key } }
    override fun remove(botId: String) { synchronized(map) { map.remove(botId) } }
    override fun ids(): List<String> = synchronized(map) { map.keys.toList() }
    override fun removeAll() { synchronized(map) { map.clear() } }
}

/**
 * The limits the gateway checks for a plaintext message and cannot for a sealed
 * one (gateway/internal/widget and bot.go).
 */
object ContentLimits {
    const val HTML_RAW = 32 * 1024
    const val HTML_COMPRESSED = 4 * 1024
    const val DATA = 1024
    const val TITLE = 256
    const val BODY = 4096
    const val COPY = 4096
    const val URL = 2048

    /** The size of [text] after zlib at level 9, as the gateway measures a card. */
    fun compressedSize(text: String): Int {
        val src = text.toByteArray()
        val d = Deflater(9)
        try {
            d.setInput(src)
            d.finish()
            val buf = ByteArray(8192)
            var total = 0
            while (!d.finished()) total += d.deflate(buf)
            return total
        } finally {
            d.end()
        }
    }

    /** Whether [html] is a card the whitelist's size limits accept. */
    fun cardFits(html: String): Boolean = html.toByteArray().size <= HTML_RAW && compressedSize(html) <= HTML_COMPRESSED

    /** [text] cut to at most [limit] characters (code points, as the gateway counts runes). */
    fun clip(text: String, limit: Int): String =
        if (text.codePointCount(0, text.length) <= limit) text else text.substring(0, text.offsetByCodePoints(0, limit))

    /**
     * The message with the limits applied that the gateway checks for plaintext: clipped title, body and copy,
     * url / icon / image that are http(s) (https for the last two), and a card only when it and its data fit (an
     * invalid card is dropped; the message stays with its body). The same rules for opened ciphertext and for
     * imported archives.
     */
    fun sanitize(m: QueuedMessage): QueuedMessage {
        val dataFits = m.data.toByteArray().size <= DATA
        val (cardHtml, cardData) = when {
            m.html.isEmpty() -> "" to (if (dataFits) m.data else "")
            dataFits && cardFits(m.html) -> m.html to m.data
            else -> "" to ""
        }
        return m.copy(
            title = clip(m.title, TITLE),
            body = clip(m.body, BODY),
            copy = clip(m.copy, COPY),
            url = link(m.url, httpsOnly = false),
            icon = link(m.icon, httpsOnly = true),
            image = link(m.image, httpsOnly = true),
            html = cardHtml,
            data = cardData,
        )
    }

    /** [v] when it is an http(s) URL with a host (https only when [httpsOnly]), else "". */
    fun link(v: String, httpsOnly: Boolean): String {
        if (v.toByteArray().size > URL) return ""
        val u = try {
            URI(v)
        } catch (e: Exception) {
            return ""
        }
        val scheme = u.scheme?.lowercase() ?: return ""
        if (u.host.isNullOrEmpty()) return ""
        return if (scheme == "https" || (!httpsOnly && scheme == "http")) v else ""
    }
}

/**
 * Turns the queue's sealed items into the plain ones LocalStore.apply stores.
 * Every path that applies queue items goes through it: sync and the FCM
 * service's fetch. The same rules as HonkKit's `MessageOpener`.
 *
 * [placeholder] is the body of the message left in the chat when a ciphertext
 * cannot be opened ("Couldn't decrypt this notification", localised by the app).
 */
class MessageOpener(private val keys: BotKeyProvider, private val placeholder: String) {
    /**
     * The item ready to apply, or null to skip it (an edit that cannot be
     * opened changes nothing).
     *
     * A bot with a key on this device only takes sealed content: a plaintext
     * message for it (the gateway refuses to queue one, so it is a forgery or a
     * leftover from before encryption was turned on) cannot be trusted and
     * becomes the placeholder too.
     */
    fun open(m: QueuedMessage): QueuedMessage? {
        val key = keys.key(m.botId)
        if (m.kind == QueuedMessage.Kind.DELETE) return m
        if (m.ciphertext.isEmpty()) {
            if (key == null) return m
            return if (m.kind == QueuedMessage.Kind.MESSAGE) failed(m) else null
        }
        val json = try {
            if (key == null) throw Seal.Failure("no key")
            Json.parseToJsonElement(String(Seal.open(m.ciphertext, key, m.botId), Charsets.UTF_8)).jsonObject
        } catch (e: Exception) {
            return if (m.kind == QueuedMessage.Kind.MESSAGE) failed(m) else null
        }
        return when (m.kind) {
            QueuedMessage.Kind.EDIT -> {
                val data = text(json, "data")
                if (data.toByteArray().size > ContentLimits.DATA) null else m.copy(ciphertext = "", data = data)
            }
            else -> {
                ContentLimits.sanitize(
                    m.copy(
                        ciphertext = "",
                        title = text(json, "title"),
                        body = text(json, "body"),
                        copy = text(json, "copy"),
                        url = text(json, "url"),
                        icon = text(json, "icon"),
                        image = text(json, "image"),
                        html = text(json, "html"),
                        data = text(json, "data"),
                    ),
                )
            }
        }
    }

    /**
     * Whether [open] gets the item's content: a plaintext item for a bot without
     * a key, or a ciphertext that opens with the key held now. The FCM service
     * checks it to know when to fetch the wrapped key first.
     */
    fun opens(m: QueuedMessage): Boolean {
        if (m.kind == QueuedMessage.Kind.DELETE) return true
        val key = keys.key(m.botId)
        if (m.ciphertext.isEmpty()) return key == null
        if (key == null) return false
        return try {
            Seal.open(m.ciphertext, key, m.botId)
            true
        } catch (e: Seal.Failure) {
            false
        }
    }

    private fun failed(m: QueuedMessage) = QueuedMessage(
        id = m.id, botId = m.botId, kind = QueuedMessage.Kind.MESSAGE, body = placeholder, level = m.level, group = m.group,
        silent = m.silent, collapseId = m.collapseId, date = m.date, placeholder = true,
    )

    /** A string field: a JSON string as it is, any other value as its JSON text (`data` may be an object). */
    private fun text(o: JsonObject, name: String): String = when (val v: JsonElement? = o[name]) {
        null, JsonNull -> ""
        is JsonPrimitive -> v.content
        else -> v.toString()
    }
}

// Several devices: the counterpart of ios/HonkKit's KeyWrap, GroupKeyStoring and KeyRing.

/**
 * A bot's key sealed with the group key, as the gateway stores it in
 * `bots.key_wrapped`: AES-256-GCM(group key, bot key), additional data
 * `honk bot key v1|<bot id>`, the same text format as a message's ciphertext.
 * The gateway cannot open it; any device of the group can.
 */
object KeyWrap {
    fun aad(botId: String) = "honk bot key v1|$botId"

    fun wrap(botKey: ByteArray, groupKey: ByteArray, botId: String): String = Seal.seal(botKey, groupKey, aad(botId))

    fun wrap(botKey: ByteArray, groupKey: ByteArray, botId: String, nonce: ByteArray): String =
        Seal.seal(botKey, groupKey, aad(botId), nonce)

    /** The bot key, or null when [text] was not sealed with [groupKey] for this bot. */
    fun unwrap(text: String, groupKey: ByteArray, botId: String): ByteArray? =
        try {
            Seal.open(text, groupKey, aad(botId)).takeIf { it.size == 32 }
        } catch (e: Seal.Failure) {
            null
        }
}

/** Where the group key is kept: EncryptedSharedPreferences in the app, memory in tests. */
interface GroupKeyStore {
    fun groupKey(): ByteArray?
    fun save(key: ByteArray)
    fun remove()
}

/** The group key in memory, for tests. */
class MemoryGroupKey(@Volatile private var key: ByteArray? = null) : GroupKeyStore {
    override fun groupKey(): ByteArray? = key
    override fun save(key: ByteArray) { this.key = key }
    override fun remove() { key = null }
}

/**
 * The gateway already has encryption on for the bot, but its key has not reached this device (a phone paired a
 * moment ago). Making a new key here would replace the group's, so the device waits for another one to share it.
 */
class WaitingForKeyException : Exception("等待其他设备同步密钥：这个 Bot 已开启加密，密钥还没到这台设备。")

/**
 * The bot keys and the group key of this device, and how they agree with the
 * wrapped keys on the gateway.
 */
class KeyRing(val keys: BotKeyStore, val group: GroupKeyStore) {
    /** The group key, made on first need. */
    @Synchronized
    fun ensureGroupKey(): ByteArray = group.groupKey() ?: Seal.generateKey().also(group::save)

    /**
     * [botId]'s key wrapped with the group key, for `PATCH /v1/bots/:id`; null without a local key. It uses the
     * existing group key and makes one only when [createGroupKey] is set (where a patch is about to be sent), so a
     * no-op reconcile (the notification extension) never mints a key as a side effect.
     */
    @Synchronized
    fun wrapped(botId: String, createGroupKey: Boolean = false): String? {
        val k = keys.key(botId) ?: return null
        val g = (if (createGroupKey) ensureGroupKey() else group.groupKey()) ?: return null
        return KeyWrap.wrap(k, g, botId)
    }

    /**
     * Turns encryption on for [bot] (as the gateway lists it now) and returns its key.
     *
     * Off at the gateway: this device's key, else a new one, is wrapped with the group key and sent through [patch]
     * (which also sets `encrypted`); the key is stored only once that succeeded. On at the gateway: the key is the
     * group's, so it is taken from the gateway's wrapped one ([reconcile]); with no key to be had this throws
     * [WaitingForKeyException] instead of making a new one.
     */
    fun enable(bot: Bot, patch: (wrapped: String) -> Unit): ByteArray {
        if (bot.encrypted) {
            reconcile(listOf(bot)) { _, wrapped -> patch(wrapped) }
            return keys.key(bot.id) ?: throw WaitingForKeyException()
        }
        val k = keys.key(bot.id) ?: Seal.generateKey()
        publish(k, bot.id, patch)
        return k
    }

    /** Replaces the bot's key with a new one and returns it. The old key stays if [patch] fails. */
    fun reset(botId: String, patch: (wrapped: String) -> Unit): ByteArray {
        val k = Seal.generateKey()
        publish(k, botId, patch)
        return k
    }

    /** Wraps [key] with the group key (made now if need be: a patch is about to be sent), sends it, then keeps it. */
    private fun publish(key: ByteArray, botId: String, patch: (String) -> Unit) {
        patch(KeyWrap.wrap(key, ensureGroupKey(), botId))
        keys.save(botId, key)
    }

    /** What a pairing bundle carries: every listed bot's key (base64url). */
    fun bundleKeys(botIds: List<String>): Map<String, String> =
        botIds.mapNotNull { id -> keys.key(id)?.let { id to Seal.encode(it) } }.toMap()

    /**
     * A claiming device takes the creator's group key and bot keys. Its own keys
     * for other bots stay; [reconcile] wraps them with the adopted group key.
     */
    fun adopt(bundle: LinkBundle) {
        bundle.groupKey?.let(Seal::parseKey)?.let(group::save)
        bundle.keys?.forEach { (id, text) -> Seal.parseKey(text)?.let { keys.save(id, it) } }
    }

    /**
     * Makes this device and the gateway agree about each encrypted bot of [bots]:
     *
     * - the gateway's wrapped key opens with our group key: it is the group's
     *   current key (another device turned encryption on or reset it), so keep it;
     * - otherwise, with a local key: wrap ours and send it ([patch]), so the other
     *   devices can open it (this also covers a claiming device whose own keys
     *   were wrapped with its old group key);
     * - otherwise nothing: without the group key (pair this phone) or a wrapped
     *   key, the bot's messages show the placeholder.
     *
     * A bot the gateway lists as not encrypted loses its local key (another device turned encryption off), so its
     * plaintext messages are not taken for forgeries.
     *
     * A failed [patch] is skipped; the next refresh tries again. With [createGroupKey] off (a push handler that
     * only wants to adopt keys) a missing group key is not made, so nothing is wrapped and sent.
     */
    fun reconcile(bots: List<Bot>, createGroupKey: Boolean = true, patch: (botId: String, wrapped: String) -> Unit) {
        for (bot in bots) {
            if (!bot.encrypted) {
                if (keys.key(bot.id) != null) keys.remove(bot.id)
                continue
            }
            val local = keys.key(bot.id)
            val g = group.groupKey()
            val k = if (g != null && bot.keyWrapped.isNotEmpty()) KeyWrap.unwrap(bot.keyWrapped, g, bot.id) else null
            if (k != null) {
                if (local == null || !local.contentEquals(k)) keys.save(bot.id, k)
            } else {
                val w = wrapped(bot.id, createGroupKey) ?: continue
                try {
                    patch(bot.id, w)
                } catch (e: Exception) {
                    // Next refresh.
                }
            }
        }
    }
}
