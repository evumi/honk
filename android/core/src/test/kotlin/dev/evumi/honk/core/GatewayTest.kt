package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Serves canned gateway responses and records the requests. */
class FakeGateway(private val handler: (method: String, path: String, body: String?) -> Pair<Int, String>) : Transport {
    data class Request(val method: String, val path: String, val headers: Map<String, String>, val body: String?)

    val requests = mutableListOf<Request>()

    override fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
        val path = url.removePrefix(BASE)
        requests += Request(method, path, headers, body)
        return handler(method, path, body)
    }

    companion object {
        const val BASE = "http://gw.test/"
        fun ok(result: String) = 200 to """{"ok":true,"result":$result}"""
        fun fail(code: Int, desc: String) = code to """{"ok":false,"error_code":$code,"description":"$desc"}"""
    }
}

class MemoryTokens(val map: MutableMap<String, String> = mutableMapOf()) : BotTokenStore {
    override fun token(botId: String) = map[botId]
    override fun save(botId: String, token: String) { map[botId] = token }
    override fun remove(botId: String) { map.remove(botId) }
    override fun removeAll() = map.clear()
}

class MemoryCredentials(var value: Credentials? = null) : CredentialStore {
    override fun load() = value
    override fun save(c: Credentials) { value = c }
    override fun clear() { value = null }
}

class GatewayTest {
    @Test fun syncAppliesPagesAndAcks() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "old", collapseId = "dep"), "c1:dep-old")
        val gw = FakeGateway { method, path, _ ->
            when {
                path == "v1/sync?cursor=0&limit=2" -> FakeGateway.ok(
                    """{"messages":[
                        {"message_id":2,"bot_id":"b1","kind":"message","body":"new","id":"dep","date":10},
                        {"message_id":3,"bot_id":"b2","kind":"message","body":"x","date":11}
                       ],"cursor":3,"has_more":true}""",
                )
                path == "v1/sync?cursor=3&limit=2" -> FakeGateway.ok(
                    """{"messages":[{"message_id":4,"bot_id":"b2","kind":"delete","target_id":3,"date":12}],"cursor":4,"has_more":false}""",
                )
                method == "POST" && path == "v1/ack" -> FakeGateway.ok("""{"acked":2}""")
                else -> FakeGateway.fail(404, "Not Found")
            }
        }
        val out = SyncEngine(ApiClient(FakeGateway.BASE, "s3cret", gw), store).run(pageSize = 2)

        assertEquals(3, out.applied)
        assertEquals(listOf("c1:dep-old"), out.staleNotificationIds)
        assertEquals(4L, store.syncCursor)
        assertEquals(listOf(2L), store.messages("b1").map { it.id })
        assertTrue(store.messages("b2").isEmpty())
        val acks = gw.requests.filter { it.path == "v1/ack" }.map { it.body }
        assertEquals(listOf("""{"up_to":3}""", """{"up_to":4}"""), acks)
        assertTrue(gw.requests.all { it.headers["Authorization"] == "Bearer s3cret" })
    }

    @Test fun syncWithNothingNewDoesNotAck() {
        val store = tempStore()
        store.syncCursor = 9
        val gw = FakeGateway { _, path, _ ->
            if (path.startsWith("v1/sync?cursor=9")) FakeGateway.ok("""{"messages":[],"cursor":9,"has_more":false}""")
            else FakeGateway.fail(404, "Not Found")
        }
        assertEquals(0, SyncEngine(ApiClient(FakeGateway.BASE, "s", gw), store).run().applied)
        assertTrue(gw.requests.none { it.path == "v1/ack" })
    }

    @Test fun syncIsSafeToRepeatAfterAFailedAck() {
        val store = tempStore()
        var ackFails = true
        val gw = FakeGateway { _, path, _ ->
            when {
                path.startsWith("v1/sync") -> FakeGateway.ok(
                    """{"messages":[{"message_id":2,"bot_id":"b1","kind":"message","body":"a"}],"cursor":2,"has_more":false}""",
                )
                path == "v1/ack" && ackFails -> FakeGateway.fail(500, "Internal Server Error")
                else -> FakeGateway.ok("""{"acked":1}""")
            }
        }
        val engine = SyncEngine(ApiClient(FakeGateway.BASE, "s", gw), store)
        assertThrows(ApiException.Gateway::class.java) { engine.run() }
        ackFails = false
        engine.run()
        assertEquals(listOf(2L), store.messages("b1").map { it.id })
    }

    @Test fun gatewayErrorsAndNotRegistered() {
        val gw = FakeGateway { _, _, _ -> FakeGateway.fail(401, "Unauthorized") }
        val e = assertThrows(ApiException.Gateway::class.java) { ApiClient(FakeGateway.BASE, "s", gw).listBots() }
        assertTrue(e.isUnauthorized)
        assertThrows(ApiException.NotRegistered::class.java) { ApiClient(FakeGateway.BASE, null, gw).listBots() }
        val bad = FakeGateway { _, _, _ -> 502 to "<html>bad gateway</html>" }
        assertThrows(ApiException.BadResponse::class.java) { ApiClient(FakeGateway.BASE, "s", bad).listBots() }
    }

    @Test fun decodesGatewayShapes() {
        val gw = FakeGateway { _, path, _ ->
            when (path) {
                "v1/bots" -> FakeGateway.ok("""[{"id":"b1","name":"部署","avatar":"preset:ship:#1c1c1e","default_level":"timeSensitive","created_at":5,"updated_at":6}]""")
                "v1/messages/7" -> FakeGateway.ok("""{"message_id":7,"bot_id":"b1","kind":"edit","target_id":3,"data":"{\"a\":1}","id":"dep","date":99}""")
                "v1/bots/b1/token" -> FakeGateway.ok("""{"token":"b1:abc"}""")
                else -> FakeGateway.fail(404, "Not Found")
            }
        }
        val api = ApiClient(FakeGateway.BASE, "s", gw)
        assertEquals(listOf(Bot("b1", "部署", "preset:ship:#1c1c1e", "timeSensitive", 5, 6)), api.listBots())
        assertEquals(
            QueuedMessage(7, "b1", QueuedMessage.Kind.EDIT, targetId = 3, data = """{"a":1}""", collapseId = "dep", date = 99),
            api.message(7),
        )
        assertEquals("b1:abc", api.resetToken("b1"))
        // A gateway from before short ids sends integers.
        val legacy = ApiClient.JSON.decodeFromString(Bot.serializer(), """{"id":4,"name":"b"}""")
        assertEquals("4", legacy.id)
        assertTrue(BotIds.isLegacy(legacy.id))
        assertTrue(!BotIds.isLegacy("aZ3kQ9xT"))
        assertThrows(Exception::class.java) { ApiClient.JSON.decodeFromString(Bot.serializer(), """{"id":null,"name":"b"}""") }
    }

    @Test fun pushBeforeTheRefreshRenamesFirst() {
        val store = legacyStore()
        store.setMuted("4", true)
        val gw = FakeGateway { _, path, _ ->
            when (path) {
                "v1/bots" -> FakeGateway.ok("""[{"id":"aZ3kQ9xT","name":"部署","created_at":100}]""")
                "bot4:sec/getMe" -> FakeGateway.ok("""{"id":"aZ3kQ9xT","name":"部署","created_at":100}""")
                else -> FakeGateway.fail(404, "Not Found")
            }
        }
        val api = ApiClient(FakeGateway.BASE, "s", gw)
        val out = LegacyBotIds.renameBeforePush(store, MemoryTokens(mutableMapOf("4" to "4:sec")), api)
        assertEquals(listOf(LegacyBotIds.Rename("4", "aZ3kQ9xT")), out.renamed)
        assertEquals("部署", store.bot("aZ3kQ9xT")?.name)
        assertTrue("the push sees the bot's mute flag", store.isMuted("aZ3kQ9xT"))
        assertNull("a legacy bot the list lacks goes, as in a refresh", store.bot("5"))
        assertNull("no auth header on the bot API", gw.requests.single { it.path.startsWith("bot") }.headers["Authorization"])
        // Nothing to do once renamed: no more requests.
        val before = gw.requests.size
        LegacyBotIds.renameBeforePush(store, MemoryTokens(), api)
        assertEquals(before, gw.requests.size)
    }

    @Test fun migratesIntegerBotIds() {
        val path = tempPath()
        JdbcSql(path).apply {
            LocalStore.SCHEMA_V1.forEach(::exec)
            exec("INSERT INTO bots (id, name) VALUES (4, 'b')")
            exec("INSERT INTO messages (id, bot_id, body, date) VALUES (1, 4, 'old', 1)")
            exec("PRAGMA user_version = 1")
            close()
        }
        val store = LocalStore(JdbcSql(path))
        assertEquals(listOf("4"), store.botIds())
        assertEquals(listOf("old"), store.messages("4").map { it.body })
        // Text ids that look like numbers stay text.
        store.saveBot(Bot("123", "n"))
        store.apply(QueuedMessage(2, "123", body = "x"))
        assertEquals(1, store.messages("123").size)
    }

    @Test fun updateBotSendsOnlyGivenFields() {
        val gw = FakeGateway { _, _, _ -> FakeGateway.ok("""{"id":1,"name":"n"}""") }
        ApiClient(FakeGateway.BASE, "s", gw).updateBot("b1", name = "n")
        assertEquals("PATCH", gw.requests.single().method)
        assertEquals("""{"name":"n"}""", gw.requests.single().body)
    }

    @Test fun registerThenUpdateThenReregisterOn401() {
        val creds = MemoryCredentials()
        var forgot = false
        val gw = FakeGateway { method, path, _ ->
            when {
                method == "POST" && path == "v1/devices" ->
                    FakeGateway.ok("""{"device":{"id":"dev-${gwCount()}","platform":"android","push_ok":true},"device_secret":"sec"}""")
                method == "PUT" && path == "v1/devices/me" ->
                    if (forgot) FakeGateway.fail(401, "Unauthorized") else FakeGateway.ok("""{"id":"dev-1","platform":"android","push_ok":true}""")
                else -> FakeGateway.fail(404, "Not Found")
            }
        }
        counter = 0
        val reg = DeviceRegistrar(FakeGateway.BASE, creds, gw)
        assertEquals(DeviceRegistrar.Result.REGISTERED, reg.register("t1"))
        assertEquals(Credentials("dev-1", "sec", "t1"), creds.value)
        assertTrue(gw.requests.last().body!!.contains("\"platform\":\"android\""))
        assertNull(gw.requests.last().headers["Authorization"])

        assertEquals(DeviceRegistrar.Result.UNCHANGED, reg.register("t1"))
        assertEquals(DeviceRegistrar.Result.UPDATED, reg.register("t2"))
        assertEquals("t2", creds.value?.pushToken)

        forgot = true
        assertEquals(DeviceRegistrar.Result.REGISTERED, reg.register("t3"))
        assertEquals(Credentials("dev-2", "sec", "t3"), creds.value)
    }

    @Test fun registerKeepsCredentialsOnOtherErrors() {
        val creds = MemoryCredentials(Credentials("d", "s", "t1"))
        val gw = FakeGateway { _, _, _ -> FakeGateway.fail(500, "Internal Server Error") }
        assertThrows(ApiException.Gateway::class.java) { DeviceRegistrar(FakeGateway.BASE, creds, gw).register("t2") }
        assertEquals(Credentials("d", "s", "t1"), creds.value)
    }

    @Test fun registerSendsTheRegisterKeyOnlyWhenSet() {
        val gw = FakeGateway { _, _, _ -> FakeGateway.ok("""{"device":{"id":"d","platform":"android","push_ok":true},"device_secret":"sec"}""") }
        DeviceRegistrar(FakeGateway.BASE, MemoryCredentials(), gw, registerKey = "s3cret").register("t1")
        assertTrue(gw.requests.last().body!!.contains("\"register_key\":\"s3cret\""))
        DeviceRegistrar(FakeGateway.BASE, MemoryCredentials(), gw).register("t1")
        assertTrue(!gw.requests.last().body!!.contains("register_key"))
        DeviceRegistrar(FakeGateway.BASE, MemoryCredentials(), gw, registerKey = "").register("t1")
        assertTrue(!gw.requests.last().body!!.contains("register_key"))
    }

    @Test fun deleteDeviceCallsTheGatewayWithTheDeviceSecret() {
        val gw = FakeGateway { method, path, _ ->
            if (method == "DELETE" && path == "v1/devices/me") FakeGateway.ok("true") else FakeGateway.fail(404, "Not Found")
        }
        ApiClient(FakeGateway.BASE, "s3cret", gw).deleteDevice()
        assertEquals("Bearer s3cret", gw.requests.single().headers["Authorization"])
        val failing = FakeGateway { _, _, _ -> FakeGateway.fail(500, "Internal Server Error") }
        assertThrows(ApiException.Gateway::class.java) { ApiClient(FakeGateway.BASE, "s", failing).deleteDevice() }
        assertThrows(ApiException.NotRegistered::class.java) { ApiClient(FakeGateway.BASE, null, gw).deleteDevice() }
    }

    @Test fun infoSaysWhetherARegisterKeyIsRequired() {
        val gw = FakeGateway { _, _, _ -> FakeGateway.ok("""{"name":"honk","version":"1","api":2,"register_key_required":true}""") }
        assertTrue(ApiClient(FakeGateway.BASE, null, gw).info().registerKeyRequired)
        val plain = FakeGateway { _, _, _ -> FakeGateway.ok("""{"name":"honk","version":"1","api":2}""") }
        assertTrue(!ApiClient(FakeGateway.BASE, null, plain).info().registerKeyRequired)
    }

    private var counter = 0
    private fun gwCount(): Int = ++counter
}

class ModelTest {
    @Test fun pushInfoFromFcmData() {
        val p = PushInfo.parse(mapOf("kind" to "message", "msg_id" to "7", "bot_id" to "1", "bot_name" to "部署", "title" to "t", "body" to "b", "id" to "dep"))
        assertEquals(PushInfo(QueuedMessage.Kind.MESSAGE, 7, "1", collapseId = "dep", botName = "部署", title = "t", body = "b"), p)
        assertEquals(7L, PushInfo.parse(mapOf("kind" to "delete", "msg_id" to "8", "bot_id" to "1", "target_id" to "7"))?.targetId)
        assertNull(PushInfo.parse(mapOf("kind" to "other", "msg_id" to "8", "bot_id" to "1")))
        assertNull(PushInfo.parse(mapOf("kind" to "message", "bot_id" to "1")))
        assertEquals("aZ3kQ9xT", PushInfo.parse(mapOf("kind" to "message", "msg_id" to "7", "bot_id" to "aZ3kQ9xT"))?.botId)
    }

    @Test fun avatar() {
        assertEquals(Avatar.Preset("box", "#1c1c1e"), Avatar.parse("preset:box:#1c1c1e"))
        assertEquals("the ship is gone; its colour stays", Avatar.Preset("bell", "#c2410c"), Avatar.parse("preset:ship:#c2410c"))
        assertEquals(Avatar.Local("x.webp"), Avatar.parse("local:x.webp"))
        assertEquals(Avatar.Local("ab-12.jpg"), Avatar.parse("local:ab-12.jpg"))
        assertEquals("local:ab-12.jpg", Avatar.parse("local:ab-12.jpg").stringValue)
        assertEquals(Avatar.DEFAULT, Avatar.parse("local:../x.jpg"))
        assertEquals(Avatar.DEFAULT, Avatar.parse("local:x.bmp"))
        assertEquals(Avatar.Image("https://e.com/a.png"), Avatar.parse("https://e.com/a.png"))
        assertEquals(Avatar.DEFAULT, Avatar.parse("http://e.com/a.png"))
        assertEquals(Avatar.Preset("bell", "#000000"), Avatar.parse("preset:nope:#000000"))
        assertEquals(Avatar.DEFAULT, Avatar.parse(""))
        assertEquals(0xFF1C1C1E.toInt(), Avatar.parse("preset:box:#1c1c1e").argb)
    }
}
