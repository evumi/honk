package dev.evumi.honk.core

import java.io.InputStream
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * A time budget for a chain of network calls (an FCM message has about 20 s in all). [slice] gives each call a
 * timeout that never runs past the end.
 */
class Deadline(totalMs: Long, private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    private val end = now() + totalMs

    fun remainingMs(): Long = (end - now()).coerceAtLeast(0)

    val expired: Boolean get() = remainingMs() == 0L

    /** [capMs], or what is left when that is less (at least [MIN_SLICE_MS], as a zero timeout means "forever"). */
    fun slice(capMs: Long): Long = minOf(capMs, remainingMs()).coerceAtLeast(MIN_SLICE_MS)

    companion object {
        const val MIN_SLICE_MS = 100L
    }
}

object TimeBox {
    /**
     * Runs [body] on its own thread and waits at most [ms]: its result, or null when it did not finish in time (it
     * is interrupted, and whatever it still does goes on in the background). An exception [body] throws is thrown here.
     */
    fun <T : Any> run(ms: Long, name: String = "honk-timebox", body: () -> T): T? {
        val task = FutureTask(Callable { body() })
        Thread(task, name).apply { isDaemon = true }.start()
        return try {
            task.get(ms, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            task.cancel(true)
            null
        } catch (e: ExecutionException) {
            throw e.cause ?: e
        }
    }
}

object BoundedRead {
    /**
     * Reads [input] to its end, or null when it holds more than [maxBytes] or does not end by [deadline]. The caller
     * sets the socket's read timeout; this bounds the total, which a read timeout (it only measures the gaps) does not.
     */
    fun read(input: InputStream, maxBytes: Int, deadline: Deadline): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (true) {
            if (deadline.expired) return null
            val n = input.read(buf, 0, minOf(buf.size, maxBytes + 1 - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > maxBytes) return null
        }
        return out.toByteArray()
    }
}
