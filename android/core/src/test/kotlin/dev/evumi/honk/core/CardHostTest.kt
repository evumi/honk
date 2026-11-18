package dev.evumi.honk.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

// The same cases as CardHostTests in native/swift/Tests. The JNI library is
// built for this machine by `make -C native jni` (the test task runs it).
class CardHostTest {
    private val changes = Collections.synchronizedList(mutableListOf<Pair<String, String>>())
    private val host = CardHost { key, result -> changes.add(key to result) }

    @After fun shutdown() = host.shutdown()

    private fun load(script: String): String = buildJsonObject {
        put("tree", buildJsonArray {
            add(buildJsonObject {
                put("type", "element"); put("tag", "p")
                put("attrs", buildJsonObject { put("id", "out") })
                put("children", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", "static") }) })
            })
            add(buildJsonObject {
                put("type", "element"); put("tag", "script"); put("attrs", buildJsonObject {})
                put("children", buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", script) }) })
            })
        })
        put("data", "{}")
        put("theme", buildJsonObject { put("--tg-color-scheme", "light") })
        put("language", "en")
        put("active", true)
    }.toString()

    @Test fun opensClicksAndCloses() {
        val r = host.open("a", load("""
            var b = document.createElement('button'); b.textContent = 'go'; document.body.appendChild(b);
            b.addEventListener('click', function () { b.textContent = 'went 😀'; TelegramWidget.openLink('https://example.com') });
        """))
        assertTrue(r, r.contains("\"text\":\"go\""))
        val c = host.click("a", "[2]")
        // Non-BMP text survives the trip through JNI.
        assertTrue(c, c.contains("\"text\":\"went 😀\""))
        Json.parseToJsonElement(c) // well-formed
        assertTrue(c, c.contains("\"open\":\"https://example.com\""))
        host.close("a")
        assertEquals(0, host.count)
        assertTrue(host.click("a", "[2]").contains("\"stopped\":\"closed\""))
    }

    @Test fun timersReportChanges() {
        host.open("t", load("""
            var n = 0; var id = setInterval(function () { n++; document.getElementById('out').textContent = 'tick ' + n; if (n === 2) clearInterval(id) }, 20);
        """))
        Thread.sleep(300)
        assertEquals(2, changes.size)
        assertEquals("t", changes.last().first)
        assertTrue(changes.last().second.contains("tick 2"))
    }

    @Test fun endlessLoopStopsWithoutBlockingOtherCards() {
        val start = System.nanoTime()
        val r = host.open("loop", load("while (true) {}"))
        assertTrue(r, r.contains("\"stopped\":\"time\""))
        assertTrue((System.nanoTime() - start) / 1_000_000 < 1000)
        assertTrue(host.open("ok", load("document.getElementById('out').textContent = 'fine'")).contains("fine"))
    }

    @Test fun keepsAtMostMaxCards() {
        repeat(CardHost.MAX_CARDS + 3) { host.open("k$it", load("")) }
        assertEquals(CardHost.MAX_CARDS, host.count)
        assertTrue(host.set("k0", "{}").contains("\"stopped\":\"closed\""))
    }
}
