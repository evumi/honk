package dev.evumi.honk.core

// The contract with the nsh app (app/src/host.ts), on the :core side: how a
// host call's JSON arguments are read and how its results and events are
// written. android/app's NshBridge only wires these to the app's services. The
// samples in app/src/host.contract.json are tested against all of this here,
// in ios/HonkKit's HostContract.swift and in app/src/host.contract.test.ts.

/** Reads the JSON object a host call passes (nsh gives Map, List, String, Number and Boolean). */
class Args(data: Any?) {
    private val map: Map<*, *> = data as? Map<*, *> ?: emptyMap<String, Any>()

    fun string(k: String): String? = when (val v = map[k]) {
        is String -> v
        is Number -> v.toLong().toString()
        else -> null
    }

    fun bool(k: String): Boolean? = map[k] as? Boolean

    fun long(k: String): Long? = when (val v = map[k]) {
        is Number -> v.toLong()
        is String -> v.toLongOrNull()
        else -> null
    }

    fun require(k: String): Long = long(k) ?: throw IllegalArgumentException("missing argument $k")

    fun requireString(k: String): String = string(k)?.takeIf { it.isNotEmpty() } ?: throw IllegalArgumentException("missing argument $k")
}

/** The arguments of the host calls that take more than one. */
object HostArgs {
    data class Messages(val botId: String, val before: Long?, val limit: Int) {
        constructor(a: Args) : this(a.requireString("botId"), a.long("before"), a.long("limit")?.toInt() ?: 50)
    }

    data class BotCreate(val name: String, val avatar: String, val defaultLevel: String) {
        constructor(a: Args) : this(a.requireString("name"), a.string("avatar").orEmpty(), a.string("defaultLevel") ?: "active")
    }

    data class BotUpdate(val botId: String, val name: String?, val avatar: String?, val defaultLevel: String?) {
        constructor(a: Args) : this(a.requireString("botId"), a.string("name"), a.string("avatar"), a.string("defaultLevel"))
    }

    data class GatewaySet(
        /** Null: back to the build's default gateway. */
        val url: String?,
        /** The gateway's register key; null (or empty) when it has none. */
        val registerKey: String?,
    ) {
        constructor(a: Args) : this(a.string("url"), a.string("registerKey")?.takeIf { it.isNotEmpty() })
    }

    /** [payload] is `load` (open), `path` (click) or `state` (set); empty for close. */
    data class CardCall(val key: String, val payload: String) {
        constructor(a: Args, payload: String?) : this(a.requireString("key"), payload?.let { a.requireString(it) }.orEmpty())
    }

    /**
     * Checks that [args] has what the named call needs; throws like the bridge
     * would. The contract test runs it over every sample.
     */
    fun validate(name: String, args: Any?) {
        val a = Args(args)
        when (name) {
            "honk.status", "honk.chats", "honk.refresh", "honk.register.retry", "honk.notifications.open",
            "honk.incoming.listen", "honk.gateway.get", "honk.device.delete" -> Unit
            "honk.messages" -> Messages(a)
            "honk.markRead", "honk.bot.token", "honk.bot.resetToken", "honk.bot.delete", "honk.chat.clear",
            "honk.bot.setMuted", "honk.bot.setPinned" -> a.requireString("botId")
            "honk.focus" -> Unit // a missing botId means no chat is open
            "honk.bot.create" -> BotCreate(a)
            "honk.bot.update" -> BotUpdate(a)
            "honk.message.delete" -> a.require("messageId")
            "honk.gateway.test" -> a.requireString("url")
            "honk.gateway.set" -> GatewaySet(a) // a missing url means the default gateway
            "honk.avatar.save" -> a.requireString("data")
            "honk.avatar.image" -> a.requireString("avatar")
            "honk.card.open" -> CardCall(a, "load")
            "honk.card.click" -> CardCall(a, "path")
            "honk.card.set" -> CardCall(a, "state")
            "honk.card.close" -> CardCall(a, null)
            else -> throw IllegalArgumentException("unknown host call $name")
        }
    }
}

/**
 * The JSON a host call answers with and the events the host sends: camelCase
 * keys, bot ids strings, message ids numbers. Maps may hold null (`last: null`);
 * nsh serialises through org.json, whose JSONObject(Map) drops null values, so
 * the bridge replaces them with JSONObject.NULL before it answers.
 */
object HostJson {
    fun bot(b: Bot): Map<String, Any?> =
        mapOf("id" to b.id, "name" to b.name, "avatar" to b.avatar, "defaultLevel" to b.defaultLevel, "createdAt" to b.createdAt)

    fun message(m: StoredMessage): Map<String, Any?> = mapOf(
        "id" to m.id, "botId" to m.botId, "title" to m.title, "body" to m.body, "html" to m.html, "data" to m.data,
        "level" to m.level, "group" to m.group, "url" to m.url, "copy" to m.copy, "icon" to m.icon,
        "collapseId" to m.collapseId, "date" to m.date, "read" to m.read,
    )

    fun chat(c: ChatSummary): Map<String, Any?> = mapOf(
        "bot" to bot(c.bot), "muted" to c.muted, "pinned" to c.pinned, "unread" to c.unread,
        "last" to c.last?.let(::message),
    )

    /** `honk.status` and `honk.register.retry`. */
    fun status(
        registered: Boolean, registration: String, registrationError: String? = null, pushMode: String,
        gatewayUrl: String, notifications: String, appVersion: String, appBuild: String,
    ): Map<String, Any?> = buildMap {
        put("registered", registered)
        put("registration", registration)
        if (registrationError != null) put("registrationError", registrationError)
        put("pushMode", pushMode)
        put("gatewayURL", gatewayUrl)
        put("notifications", notifications)
        put("appVersion", appVersion)
        put("appBuild", appBuild)
    }

    /** [registerKey]: the one saved for the gateway, empty when none. */
    fun gatewayGet(url: String, defaultUrl: String, custom: Boolean, registerKey: String): Map<String, Any?> =
        mapOf("url" to url, "defaultURL" to defaultUrl, "custom" to custom, "registerKey" to registerKey)

    /** [push]: how the gateway sends pushes per platform; left out for a gateway that does not say. */
    fun gatewayTest(url: String, version: String, registerKeyRequired: Boolean, push: ApiClient.PushRoutes? = null): Map<String, Any?> =
        mapOf("ok" to true, "url" to url, "version" to version, "registerKeyRequired" to registerKeyRequired) +
            (if (push != null) mapOf("push" to mapOf("ios" to push.ios, "android" to push.android)) else emptyMap())

    fun gatewayTestFailed(error: String): Map<String, Any?> = mapOf("ok" to false, "error" to error)

    fun gatewaySet(url: String, registered: Boolean): Map<String, Any?> = mapOf("url" to url, "registered" to registered)

    fun botCreated(b: Bot, token: String): Map<String, Any?> = mapOf("bot" to bot(b), "token" to token)

    // Events (`host.on`).

    fun openEvent(botId: String): Map<String, Any?> = mapOf("botId" to botId)

    fun incomingEvent(botId: String, messageId: Long): Map<String, Any?> = mapOf("botId" to botId, "messageId" to messageId)

    fun cardChangedEvent(key: String, result: String): Map<String, Any?> = mapOf("key" to key, "result" to result)
}
