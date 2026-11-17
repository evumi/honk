package dev.evumi.honk.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.Base64

// The same cases as LocalAvatarTests in ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class LocalAvatarsTest {
    private fun temp() = LocalAvatars(Files.createTempDirectory("avatars").toFile())

    @Test fun savesReadsAndPrunes() {
        val avatars = temp()
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3)
        val a = avatars.save(png)
        assertTrue(a.startsWith("local:") && a.endsWith(".png"))
        assertArrayEquals(png, avatars.data(a))
        assertEquals("data:image/png;base64," + Base64.getEncoder().encodeToString(png), avatars.dataUrl(a))
        assertNull(avatars.data("local:missing.png"))
        val b = avatars.save(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte()))
        assertTrue(b.endsWith(".jpg"))
        assertThrows(LocalAvatars.SaveException::class.java) { avatars.save("GIF89a".toByteArray()) }
        assertThrows(LocalAvatars.SaveException::class.java) { avatars.save(ByteArray(LocalAvatars.MAX_BYTES + 1)) }
        // Young files stay (a bot may be about to use them); old unused ones go.
        avatars.prune(setOf(a))
        assertNotNull(avatars.data(b))
        avatars.prune(setOf(a), now = System.currentTimeMillis() + 7_200_000)
        assertNull(avatars.data(b))
        assertNotNull(avatars.data(a))
    }
}
