package dev.evumi.honk.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.sql.DriverManager

// The same cases as CardRequestsTests in ios/HonkKit/Tests.
class CardRequestsTest {
    private class Log {
        val queries = mutableListOf<Pair<Long, String>>()
        data class Answer(val key: String, val seq: Int, val ok: Boolean, val data: String)
        val answers = mutableListOf<Answer>()
        val changes = mutableListOf<Pair<String, String>>()
    }

    private val drawn = """{"tree":[{"type":"text","text":"7"}],"prevented":false,"stopped":null,"logs":[]}"""
    private val quiet = """{"tree":null,"prevented":false,"stopped":null,"logs":[]}"""
    private val load = """{"tree":[],"data":"{}","messageId":42,"allowQueries":true}"""

    private fun requests(log: Log, answerResult: String = drawn, reply: (Long, String) -> String): CardRequests = CardRequests(
        query = { m, d -> log.queries += m to d; reply(m, d) },
        answer = { k, s, ok, d -> log.answers += Log.Answer(k, s, ok, d); answerResult },
        changed = { k, r -> log.changes += k to r },
        background = { it.run() },
    )

    @Test fun theRequestIsCutOutOfTheResultAndServed() {
        val log = Log()
        val cr = requests(log) { _, _ -> "7" }
        cr.opened("c1", load)
        val click = """{"tree":null,"prevented":false,"stopped":null,"logs":[],"request":{"seq":3,"data":"plus"}}"""
        val forApp = ApiClient.JSON.parseToJsonElement(cr.filter("c1", click)) as JsonObject
        assertFalse(forApp.containsKey("request"))
        assertEquals(JsonNull, forApp["tree"])
        assertEquals(listOf(42L to "plus"), log.queries)
        assertEquals(listOf(Log.Answer("c1", 3, true, "7")), log.answers)
        assertEquals(listOf("c1" to drawn), log.changes)
    }

    @Test fun aResultWithoutARequestIsLeftAlone() {
        val cr = requests(Log()) { _, _ -> "" }
        assertEquals(quiet, cr.filter("c1", quiet))
        // The word in a log line is not a request.
        val logged = """{"tree":null,"prevented":false,"stopped":null,"logs":["\"request\""]}"""
        assertEquals(logged, cr.filter("c1", logged))
    }

    @Test fun failuresBecomeCodesTheCardCanSee() {
        val cases = listOf<Pair<Exception, String>>(
            ApiException.Gateway(504, "Gateway Timeout") to "TIMEOUT",
            ApiException.Gateway(403, "Forbidden") to "NOT_ALLOWED",
            ApiException.Gateway(404, "Not Found") to "NOT_ALLOWED",
            ApiException.Gateway(429, "Too Many Requests") to "RATE_LIMITED",
            ApiException.Gateway(502, "Bad Gateway") to "REQUEST_FAILED",
            SocketTimeoutException("read timed out") to "TIMEOUT",
            IOException("no route") to "NETWORK",
        )
        for ((error, code) in cases) {
            val log = Log()
            val cr = requests(log) { _, _ -> throw error }
            cr.opened("c1", load)
            cr.serve("c1", 1, "x")
            assertEquals("$error", listOf(Log.Answer("c1", 1, false, code)), log.answers)
        }
    }

    @Test fun aCardThatMayNotQueryIsRefusedWithoutAQuery() {
        for (l in listOf("""{"tree":[],"messageId":42,"allowQueries":false}""", """{"tree":[]}""", "not json")) {
            val log = Log()
            val cr = requests(log) { _, _ -> "never" }
            cr.opened("c1", l)
            cr.serve("c1", 2, "x")
            assertTrue(log.queries.isEmpty())
            assertEquals(listOf(Log.Answer("c1", 2, false, "NOT_ALLOWED")), log.answers)
        }
        // A closed card (or one never opened) is refused too.
        val log = Log()
        val cr = requests(log) { _, _ -> "never" }
        cr.opened("c1", load)
        cr.closed("c1")
        cr.serve("c1", 3, "x")
        assertTrue(log.queries.isEmpty())
        assertEquals("NOT_ALLOWED", log.answers.single().data)
    }

    @Test fun anEmptyAnswerResultIsNotReported() {
        val log = Log()
        val cr = requests(log, quiet) { _, _ -> "ok" }
        cr.opened("c1", load)
        cr.serve("c1", 1, "x")
        assertTrue(log.changes.isEmpty())
        // A log line is worth reporting.
        val cr2 = requests(log, """{"tree":null,"prevented":false,"stopped":null,"logs":["hi"]}""") { _, _ -> "ok" }
        cr2.opened("c1", load)
        cr2.serve("c1", 1, "x")
        assertEquals(1, log.changes.size)
    }

    @Test fun queryPostsTheMessageAndDataAndReturnsTheAnswer() {
        val gw = FakeGateway { method, path, _ ->
            if (method == "POST" && path == "v1/queries") FakeGateway.ok("""{"data":"7"}""") else FakeGateway.fail(404, "Not Found")
        }
        val api = ApiClient(FakeGateway.BASE, "s3cret", gw)
        assertEquals("7", api.query(42, "plus"))
        val req = gw.requests.single()
        assertEquals("Bearer s3cret", req.headers["Authorization"])
        val body = ApiClient.JSON.parseToJsonElement(req.body!!).toString()
        assertEquals("""{"message_id":42,"data":"plus"}""", body)

        val failing = ApiClient(FakeGateway.BASE, "s3cret") { _, _, _, _ -> FakeGateway.fail(504, "Gateway Timeout") }
        val e = org.junit.Assert.assertThrows(ApiException.Gateway::class.java) { failing.query(42, "x") }
        assertEquals(504, e.code)
    }

    @Test fun aHostThatIsGoneDoesNotCrashTheRequestThread() {
        val cr = CardRequests(
            query = { _, _ -> "7" },
            answer = { _, _, _, _ -> throw java.util.concurrent.RejectedExecutionException("stopped") },
            changed = { _, _ -> },
            background = { it.run() },
        )
        cr.opened("c1", load)
        cr.serve("c1", 1, "x") // does not throw
    }

    @Test fun theFlagIsStoredAndEditsKeepIt() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "a", allowQueries = true, date = 1))
        store.apply(QueuedMessage(2, "b1", body = "b", date = 2))
        assertTrue(store.message(1)!!.allowQueries)
        assertFalse(store.message(2)!!.allowQueries)
        store.apply(QueuedMessage(3, "b1", QueuedMessage.Kind.EDIT, targetId = 1, data = "{}"))
        assertTrue(store.message(1)!!.allowQueries)
        // Applying the same item twice is harmless.
        store.apply(QueuedMessage(1, "b1", body = "a", allowQueries = true, date = 1))
        assertEquals(2, store.messages("b1").size)
    }

    @Test fun aV3FileGetsTheColumn() {
        val path = tempPath()
        val first = LocalStore(JdbcSql(path))
        first.replaceBots(listOf(Bot("b1", "n")))
        first.apply(QueuedMessage(1, "b1", body = "old", date = 1))
        DriverManager.getConnection("jdbc:sqlite:$path").use { c ->
            c.createStatement().use {
                it.execute("ALTER TABLE messages DROP COLUMN allow_queries")
                it.execute("ALTER TABLE messages DROP COLUMN placeholder")
                it.execute("ALTER TABLE bots DROP COLUMN encrypted")
                it.execute("PRAGMA user_version = 3")
            }
        }
        val store = LocalStore(JdbcSql(path))
        assertFalse(store.message(1)!!.allowQueries)
        store.apply(QueuedMessage(2, "b1", body = "new", allowQueries = true, date = 2))
        assertTrue(store.message(2)!!.allowQueries)
        assertNull(store.message(3))
    }

    @Test fun theGatewayJsonCarriesTheFlag() {
        val m = ApiClient.JSON.decodeFromString(QueuedMessage.serializer(), """{"message_id":1,"bot_id":"aZ3kQ9xT","kind":"message","allow_queries":true}""")
        assertTrue(m.allowQueries)
        val n = ApiClient.JSON.decodeFromString(QueuedMessage.serializer(), """{"message_id":1,"bot_id":"aZ3kQ9xT","kind":"message"}""")
        assertFalse(n.allowQueries)
    }
}
