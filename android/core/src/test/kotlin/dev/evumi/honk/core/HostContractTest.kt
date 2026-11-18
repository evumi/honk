package dev.evumi.honk.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// The samples in app/src/host.contract.json against HostArgs and HostJson. The
// same file is read by app/src/host.contract.test.ts and ios/HonkKit's
// HostContractTests.
class HostContractTest {
    private val contract: JsonObject = Json.parseToJsonElement(
        File(System.getProperty("honk.contract") ?: error("honk.contract is not set")).readText(),
    ).jsonObject

    private val calls: Map<String, JsonObject> = contract.getValue("calls").jsonObject.mapValues { it.value.jsonObject }

    private fun samples(call: String): List<JsonObject> = calls.getValue(call).getValue("samples").jsonArray.map { it.jsonObject }

    /** Plain values as nsh hands them to a handler: Map, List, String, Number, Boolean, null. */
    private fun plain(e: JsonElement?): Any? = when (e) {
        null, JsonNull -> null
        is JsonObject -> e.mapValues { plain(it.value) }
        is JsonArray -> e.map(::plain)
        is JsonPrimitive -> when {
            e.isString -> e.content
            e.content == "true" || e.content == "false" -> e.content.toBoolean()
            else -> e.content.toLong()
        }
    }

    /** What an encoder produced, as JSON to compare with a sample. */
    private fun json(v: Any?): JsonElement = when (v) {
        null -> JsonNull
        is Map<*, *> -> JsonObject(v.entries.associate { it.key as String to json(it.value) })
        is List<*> -> JsonArray(v.map(::json))
        is String -> JsonPrimitive(v)
        is Boolean -> JsonPrimitive(v)
        is Number -> JsonPrimitive(v)
        else -> error("unexpected $v")
    }

    private fun bot(j: JsonObject) = Bot(
        j.getValue("id").jsonPrimitive.content, j.getValue("name").jsonPrimitive.content, j.getValue("avatar").jsonPrimitive.content,
        j.getValue("defaultLevel").jsonPrimitive.content, j.getValue("createdAt").jsonPrimitive.long,
    )

    private fun message(j: JsonObject): StoredMessage {
        fun s(k: String) = j.getValue(k).jsonPrimitive.content
        return StoredMessage(
            j.getValue("id").jsonPrimitive.long, s("botId"), s("title"), s("body"), s("html"), s("data"), s("level"), s("group"),
            s("url"), s("copy"), s("icon"), s("open"), s("image"), s("parseMode"), j.getValue("silent").jsonPrimitive.boolean,
            s("collapseId"), j.getValue("date").jsonPrimitive.long, j.getValue("read").jsonPrimitive.boolean,
        )
    }

    private fun chat(j: JsonObject) = ChatSummary(
        bot(j.getValue("bot").jsonObject), j.getValue("muted").jsonPrimitive.boolean, j.getValue("pinned").jsonPrimitive.boolean,
        (j.getValue("last") as? JsonObject)?.let(::message), j.getValue("unread").jsonPrimitive.long.toInt(),
    )

    @Test fun everySampleArgumentIsAccepted() {
        for (name in calls.keys) {
            val list = samples(name)
            assertTrue("$name has samples", list.isNotEmpty())
            for (s in list) HostArgs.validate(name, plain(s["args"]))
        }
    }

    @Test fun callsWithRequiredArgumentsRejectNone() {
        // These take every argument as optional (a missing botId on focus means no chat is open).
        val lenient = setOf("honk.focus", "honk.gateway.set")
        for (name in calls.keys) {
            val args = samples(name).first()["args"] as? JsonObject ?: continue
            if (args.isEmpty() || name in lenient) continue
            assertThrows("$name with no arguments", IllegalArgumentException::class.java) { HostArgs.validate(name, emptyMap<String, Any?>()) }
        }
    }

    @Test fun unknownCallsAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { HostArgs.validate("honk.nope", null) }
    }

    @Test fun argumentsAreRead() {
        val m = HostArgs.Messages(Args(mapOf("botId" to "aZ3kQ9xT", "before" to 8, "limit" to 20)))
        assertEquals(HostArgs.Messages("aZ3kQ9xT", 8, 20), m)
        assertEquals(HostArgs.Messages("aZ3kQ9xT", 8, 20), HostArgs.Messages(Args(mapOf("botId" to "aZ3kQ9xT", "before" to "8", "limit" to 20))))
        assertEquals(HostArgs.Messages("b", null, 50), HostArgs.Messages(Args(mapOf("botId" to "b"))))
        assertEquals(HostArgs.BotCreate("n", "", "active"), HostArgs.BotCreate(Args(mapOf("name" to "n"))))
        assertEquals(HostArgs.GatewaySet("https://gw.test/", "s3cret"), HostArgs.GatewaySet(Args(mapOf("url" to "https://gw.test/", "registerKey" to "s3cret"))))
        assertEquals("null url: the default gateway; empty key: none", HostArgs.GatewaySet(null, null), HostArgs.GatewaySet(Args(mapOf("url" to null, "registerKey" to ""))))
        assertEquals(HostArgs.BotUpdate("b", "x", null, null), HostArgs.BotUpdate(Args(mapOf("botId" to "b", "name" to "x"))))
        assertEquals(null, Args(mapOf("n" to true)).string("n"))
        assertEquals("5", Args(mapOf("n" to 5)).string("n"))
    }

    @Test fun modelsEncodeAsTheSamples() {
        val samples = contract.getValue("samples").jsonObject
        val bot = samples.getValue("bot").jsonObject
        val message = samples.getValue("message").jsonObject
        assertEquals(bot, json(HostJson.bot(bot(bot))))
        assertEquals(message, json(HostJson.message(message(message))))
    }

    @Test fun resultsEncodeAsTheSamples() {
        for (s in samples("honk.chats")) {
            val list = s.getValue("result").jsonArray
            assertEquals(list, json(list.map { HostJson.chat(chat(it.jsonObject)) }))
        }
        for (s in samples("honk.messages")) {
            val list = s.getValue("result").jsonArray
            assertEquals(list, json(list.map { HostJson.message(message(it.jsonObject)) }))
        }
        for (s in samples("honk.bot.create")) {
            val r = s.getValue("result").jsonObject
            assertEquals(r, json(HostJson.botCreated(bot(r.getValue("bot").jsonObject), r.getValue("token").jsonPrimitive.content)))
        }
        for (s in samples("honk.bot.update")) {
            val r = s.getValue("result").jsonObject
            assertEquals(r, json(HostJson.bot(bot(r))))
        }
        for (name in listOf("honk.status", "honk.register.retry")) for (s in samples(name)) {
            val r = s.getValue("result").jsonObject
            fun str(k: String) = r.getValue(k).jsonPrimitive.content
            val out = HostJson.status(
                r.getValue("registered").jsonPrimitive.boolean, str("registration"), r["registrationError"]?.jsonPrimitive?.content,
                str("pushMode"), str("gatewayURL"), str("notifications"), str("appVersion"), str("appBuild"),
            )
            assertEquals(r, json(out))
        }
        for (s in samples("honk.gateway.get")) {
            val r = s.getValue("result").jsonObject
            fun str(k: String) = r.getValue(k).jsonPrimitive.content
            assertEquals(r, json(HostJson.gatewayGet(str("url"), str("defaultURL"), r.getValue("custom").jsonPrimitive.boolean, str("registerKey"))))
        }
        for (s in samples("honk.gateway.test")) {
            val r = s.getValue("result").jsonObject
            fun str(k: String) = r.getValue(k).jsonPrimitive.content
            val out = if (r.getValue("ok").jsonPrimitive.boolean) HostJson.gatewayTest(str("url"), str("version"), r.getValue("registerKeyRequired").jsonPrimitive.boolean, r["push"]?.jsonObject?.let { ApiClient.PushRoutes(it.getValue("ios").jsonPrimitive.content, it.getValue("android").jsonPrimitive.content) }) else HostJson.gatewayTestFailed(str("error"))
            assertEquals(r, json(out))
        }
        for (s in samples("honk.gateway.set")) {
            val r = s.getValue("result").jsonObject
            assertEquals(r, json(HostJson.gatewaySet(r.getValue("url").jsonPrimitive.content, r.getValue("registered").jsonPrimitive.boolean)))
        }
    }

    @Test fun eventsEncodeAsTheSamples() {
        val events = contract.getValue("events").jsonObject
        assertEquals(setOf("honk.changed", "honk.open", "honk.incoming", "honk.card.changed"), events.keys)
        fun sample(name: String) = events.getValue(name).jsonObject.getValue("samples").jsonArray.first().jsonObject
        val open = sample("honk.open")
        assertEquals(open, json(HostJson.openEvent(open.getValue("botId").jsonPrimitive.content)))
        val incoming = sample("honk.incoming")
        assertEquals(incoming, json(HostJson.incomingEvent(incoming.getValue("botId").jsonPrimitive.content, incoming.getValue("messageId").jsonPrimitive.long)))
        val card = sample("honk.card.changed")
        assertEquals(card, json(HostJson.cardChangedEvent(card.getValue("key").jsonPrimitive.content, card.getValue("result").jsonPrimitive.content)))
    }
}
