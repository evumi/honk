package dev.evumi.honk.core

import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.math.ceil

/** The card sandbox in libhonkcard (native/card, native/jni). Strings cross as UTF-8 bytes. */
internal object CardNative {
    init {
        System.loadLibrary("honkcard")
    }

    @JvmStatic external fun open(load: ByteArray, result: Array<ByteArray?>): Long
    @JvmStatic external fun click(card: Long, path: ByteArray): ByteArray?
    @JvmStatic external fun tick(card: Long): ByteArray?
    @JvmStatic external fun set(card: Long, state: ByteArray): ByteArray?
    @JvmStatic external fun next(card: Long): Double
    @JvmStatic external fun close(card: Long)
}

/**
 * Runs card scripts (native/card) for the nsh app: one QuickJS runtime per
 * card, all on one background thread, with their timers driven from there.
 * The app talks to it through honk.card.open, .click, .set and .close, and
 * hears timer changes as honk.card.changed; mirrors CardHost.swift.
 *
 * Strings in and out are JSON (see honk_card.h). Calls block until the card
 * thread answers: call them off the main thread.
 */
class CardHost(private val changed: (key: String, result: String) -> Unit) {
    companion object {
        /** Cards kept at once; opening one more closes the least recently used. */
        const val MAX_CARDS = 16
        private const val NO_RUNTIME = """{"tree":null,"prevented":false,"stopped":"error","logs":["no runtime"]}"""
        private const val CLOSED = """{"tree":null,"prevented":false,"stopped":"closed","logs":[]}"""
        private const val UNCHANGED = """{"tree":null,"prevented":false,"stopped":null,"logs":[]}"""
    }

    // QuickJS checks its own stack limit (256 KB); the thread gets plenty more.
    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(null, r, "honk-cards", 4L shl 20).apply { isDaemon = true }
    }
    private val cards = LinkedHashMap<String, Long>(16, 0.75f, true) // access order: least recently used first
    private val timers = HashMap<String, ScheduledFuture<*>>()

    fun open(key: String, load: String): String = onThread {
        closeNow(key)
        while (cards.size >= MAX_CARDS) closeNow(cards.keys.first())
        val out = arrayOfNulls<ByteArray>(1)
        val card = CardNative.open(load.toByteArray(Charsets.UTF_8), out)
        if (card == 0L) return@onThread NO_RUNTIME
        cards[key] = card
        schedule(key)
        text(out[0])
    }

    fun click(key: String, path: String): String = call(key) { CardNative.click(it, path.toByteArray(Charsets.UTF_8)) }

    fun set(key: String, state: String): String = call(key) { CardNative.set(it, state.toByteArray(Charsets.UTF_8)) }

    fun close(key: String) {
        onThread { closeNow(key) }
    }

    /** Cards open now (for tests). */
    val count: Int get() = onThread { cards.size }

    /** Closes every card and stops the thread. */
    fun shutdown() {
        onThread { cards.keys.toList().forEach(::closeNow) }
        executor.shutdown()
    }

    private fun <T> onThread(body: () -> T): T = executor.submit(Callable(body)).get()

    private fun call(key: String, body: (Long) -> ByteArray?): String = onThread {
        val card = cards[key] ?: return@onThread CLOSED
        val result = text(body(card))
        schedule(key)
        result
    }

    private fun closeNow(key: String) {
        timers.remove(key)?.cancel(false)
        cards.remove(key)?.let(CardNative::close)
    }

    /** Schedules the card's next tick, replacing one already scheduled. */
    private fun schedule(key: String) {
        timers.remove(key)?.cancel(false)
        val card = cards[key] ?: return
        val next = CardNative.next(card)
        if (next < 0) return
        timers[key] = executor.schedule({ tick(key) }, ceil(next).toLong(), TimeUnit.MILLISECONDS)
    }

    private fun tick(key: String) {
        timers.remove(key)
        // Reading through `cards.get` would count as a use: peek without reordering.
        val card = cards.entries.firstOrNull { it.key == key }?.value ?: return
        val result = text(CardNative.tick(card))
        schedule(key)
        // Only changes are worth a message to the app.
        if (!result.startsWith(UNCHANGED)) changed(key, result)
    }

    private fun text(b: ByteArray?): String = b?.toString(Charsets.UTF_8) ?: NO_RUNTIME
}
