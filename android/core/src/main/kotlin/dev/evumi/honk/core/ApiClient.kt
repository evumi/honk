package dev.evumi.honk.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** An error the gateway returned (`{"ok":false,…}`), or a response that could not be read. */
sealed class ApiException(message: String, cause: Throwable? = null) : IOException(message, cause) {
    class Gateway(val code: Int, val description: String) : ApiException("$code $description")
    class NotRegistered : ApiException("这台设备还没有注册到网关。到「设置 → 设备注册」查看原因并重试。")
    class BadResponse(cause: Throwable? = null) : ApiException("网关的响应无法解析，请确认地址是 Honk 网关", cause)

    /** The device secret is unknown to the gateway (the device was deleted). */
    val isUnauthorized: Boolean get() = this is Gateway && code == 401
}

/** Sends one HTTP request. [HttpTransport] in the app; a fake in tests. */
fun interface Transport {
    /** Returns the status and body; throws IOException on a network failure. */
    fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String>
}

/** [Transport] over HttpURLConnection, which is on the JVM and on Android. */
class HttpTransport(private val timeoutMs: Int = 15_000) : Transport {
    override fun send(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            headers.forEach(conn::setRequestProperty)
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toByteArray()) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            return status to text
        } finally {
            conn.disconnect()
        }
    }
}

/** A client for the gateway's app API (`/v1`). Blocking: call it off the main thread. */
class ApiClient(
    baseUrl: String,
    private val secret: String?,
    private val transport: Transport = HttpTransport(),
) {
    private val base = baseUrl.trimEnd('/') + "/"

    // gateway

    /** What the gateway says it is; a Honk gateway answers `name` "honk". */
    @Serializable
    data class GatewayInfo(
        val name: String = "",
        val version: String = "",
        val api: Int = 0,
        /** The gateway only registers devices that send its `register_key` (HONK_REGISTER_KEY). */
        @SerialName("register_key_required") val registerKeyRequired: Boolean = false,
    )

    fun info(): GatewayInfo = request("GET", "v1/info", GatewayInfo.serializer(), auth = false)

    // devices

    @Serializable
    data class Registration(val device: DeviceInfo, @SerialName("device_secret") val deviceSecret: String)

    /** [registerKey]: what a gateway with HONK_REGISTER_KEY set wants to see; sent only when not empty. */
    fun registerDevice(pushToken: String, platform: String = "android", registerKey: String? = null): Registration {
        val body = buildMap<String, Any> {
            put("platform", platform)
            put("push_token", pushToken)
            if (!registerKey.isNullOrEmpty()) put("register_key", registerKey)
        }
        return request("POST", "v1/devices", Registration.serializer(), body = body, auth = false)
    }

    /** Deletes this device on the gateway with its bots and queued messages (`DELETE /v1/devices/me`). */
    fun deleteDevice() {
        request("DELETE", "v1/devices/me", JsonElement.serializer())
    }

    fun updatePushToken(token: String): DeviceInfo =
        request("PUT", "v1/devices/me", DeviceInfo.serializer(), body = mapOf("push_token" to token))

    // bots

    @Serializable
    data class CreatedBot(val bot: Bot, val token: String)

    @Serializable
    private data class Token(val token: String)

    fun listBots(): List<Bot> = request("GET", "v1/bots", ListSerializer(Bot.serializer()))

    fun createBot(name: String, avatar: String, defaultLevel: String): CreatedBot =
        request("POST", "v1/bots", CreatedBot.serializer(), body = mapOf("name" to name, "avatar" to avatar, "default_level" to defaultLevel))

    fun updateBot(id: String, name: String? = null, avatar: String? = null, defaultLevel: String? = null): Bot {
        val body = buildMap<String, Any> {
            name?.let { put("name", it) }
            avatar?.let { put("avatar", it) }
            defaultLevel?.let { put("default_level", it) }
        }
        return request("PATCH", "v1/bots/$id", Bot.serializer(), body = body)
    }

    fun resetToken(botId: String): String = request("POST", "v1/bots/$botId/token", Token.serializer()).token

    fun deleteBot(id: String) {
        request("DELETE", "v1/bots/$id", JsonElement.serializer())
    }

    // messages

    @Serializable
    data class SyncPage(val messages: List<QueuedMessage> = emptyList(), val cursor: Long, @SerialName("has_more") val hasMore: Boolean = false)

    fun message(id: Long): QueuedMessage = request("GET", "v1/messages/$id", QueuedMessage.serializer())

    fun sync(cursor: Long, limit: Int = 100): SyncPage = request("GET", "v1/sync?cursor=$cursor&limit=$limit", SyncPage.serializer())

    /**
     * The bot a token belongs to, through the bot API (`/bot<token>/getMe`).
     * The app uses it to learn the short id of a bot it knew by a legacy id.
     */
    fun getMe(token: String): Bot =
        request("GET", "bot" + java.net.URLEncoder.encode(token, "UTF-8").replace("%3A", ":") + "/getMe", Bot.serializer(), auth = false)

    fun ack(upTo: Long) {
        request("POST", "v1/ack", JsonElement.serializer(), body = mapOf("up_to" to upTo))
    }

    // transport

    private fun <T> request(method: String, path: String, result: KSerializer<T>, body: Map<String, Any>? = null, auth: Boolean = true): T {
        val headers = mutableMapOf("Accept" to "application/json")
        if (auth) {
            val s = secret ?: throw ApiException.NotRegistered()
            headers["Authorization"] = "Bearer $s"
        }
        var payload: String? = null
        if (body != null) {
            headers["Content-Type"] = "application/json"
            payload = JsonObject(body.mapValues { (_, v) ->
                when (v) {
                    is String -> JsonPrimitive(v)
                    is Number -> JsonPrimitive(v)
                    is Boolean -> JsonPrimitive(v)
                    else -> error("unsupported body value $v")
                }
            }).toString()
        }
        val (_, text) = transport.send(method, base + path, headers, payload)
        val env = try {
            JSON.parseToJsonElement(text) as JsonObject
        } catch (e: Exception) {
            throw ApiException.BadResponse(e)
        }
        val ok = (env["ok"] as? JsonPrimitive)?.booleanOrNull == true
        val res = env["result"]
        if (!ok || res == null) {
            throw ApiException.Gateway(
                code = (env["error_code"] as? JsonPrimitive)?.intOrNull ?: 0,
                description = (env["description"] as? JsonPrimitive)?.content.orEmpty(),
            )
        }
        return try {
            JSON.decodeFromJsonElement(result, res)
        } catch (e: Exception) {
            throw ApiException.BadResponse(e)
        }
    }

    companion object {
        val JSON = Json {
            ignoreUnknownKeys = true
            coerceInputValues = true
        }
    }
}
