package dev.evumi.honk.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class DeadlineTest {
    @Test fun slicesNeverRunPastTheEnd() {
        var t = 0L
        val d = Deadline(1000, now = { t })
        assertEquals(500, d.slice(500))
        t = 800
        assertEquals(200, d.slice(500))
        t = 2000
        assertTrue(d.expired)
        assertEquals("never zero: a zero timeout would wait forever", Deadline.MIN_SLICE_MS, d.slice(500))
    }

    @Test fun timeBoxReturnsTheResultOrNullOnTimeout() {
        assertEquals(7, TimeBox.run(2000) { 7 })
        assertNull(TimeBox.run(50) { Thread.sleep(5000); 7 })
        assertThrows(IllegalStateException::class.java) { TimeBox.run(2000) { error("boom") } }
    }

    @Test fun boundedReadStopsPastTheCapAndPastTheDeadline() {
        val data = ByteArray(100) { it.toByte() }
        assertArrayEquals(data, BoundedRead.read(ByteArrayInputStream(data), 100, Deadline(10_000)))
        assertNull("past the cap", BoundedRead.read(ByteArrayInputStream(data), 99, Deadline(10_000)))
        var t = 0L
        val slow = object : InputStream() {
            override fun read(): Int = 1
            override fun read(b: ByteArray, off: Int, len: Int): Int { t += 400; b[off] = 1; return 1 }
        }
        assertNull("a trickle that never ends", BoundedRead.read(slow, 1_000_000, Deadline(1000, now = { t })))
    }
}
