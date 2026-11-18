package dev.evumi.honk.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.Executors

/**
 * A card's `request(data)` (native/card), served by the host: the nsh app is not involved.
 * Mirrors `CardRequests` in ios/HonkKit.
 *
 * A click's result may carry `"request":{"seq":N,"data":"…"}`. [filter] cuts it out of the result the
 * app gets and, in the background, sends the data to the message's bot ([query], `POST /v1/queries`),
 * then hands the reply to the card ([answer], `CardHost.answer`) and passes the card's new result on
 * as [changed]. Failures reach the card as error codes: `TIMEOUT` (the bot did not answer in time),
 * `NOT_ALLOWED` (the message does not allow queries, or is gone), `NETWORK`, `RATE_LIMITED`, and
 * `REQUEST_FAILED` for anything else.
 */
class CardRequests(
    /** Sends a query and returns the bot's answer; blocking, throws on failure. */
    private val query: (messageId: Long, data: String) -> String,
    /** Gives the card its answer; returns the card's new result. */
    private val answer: (key: String, seq: Int, ok: Boolean, data: String) -> String,
    private val changed: (key: String, result: String) -> Unit,
    /** Runs a request in the background. Tests run it in place. */
    private val background: (Runnable) -> Unit = { POOL.execute(it) },
) {
    private class Source(val messageId: Long, val allowed: Boolean)

    private val sources = HashMap<String, Source>()

    /** Remembers which message a card shows: its `load` (the app's JSON) has `messageId` and `allowQueries`. */
    fun opened(key: String, load: String) {
        val obj = try {
            ApiClient.JSON.parseToJsonElement(load) as? JsonObject
        } catch (e: Exception) {
            null
        }
        val source = Source(
            messageId = obj?.get("messageId")?.jsonPrimitive?.longOrNull ?: 0,
            allowed = obj?.get("allowQueries")?.jsonPrimitive?.booleanOrNull ?: false,
        )
        synchronized(sources) { sources[key] = source }
    }

    fun closed(key: String) {
        synchronized(sources) { sources.remove(key) }
    }

    /** Takes the `request` out of a card's result. With one, the query goes out in the background. Returns the result for the app. */
    fun filter(key: String, result: String): String {
        val (stripped, req) = split(result) ?: return result
        background(Runnable { serve(key, req.first, req.second) })
        return stripped
    }

    /** Runs one request to its end: query, answer the card, report what the card then drew. */
    internal fun serve(key: String, seq: Int, data: String) {
        val source = synchronized(sources) { sources[key] }
        var ok = false
        var reply = "NOT_ALLOWED"
        if (source != null && source.allowed && source.messageId > 0) {
            try {
                reply = query(source.messageId, data)
                ok = true
            } catch (e: Exception) {
                reply = code(e)
            }
        }
        // The card's host may be gone by now (the activity was destroyed and its executor stopped, so `answer`
        // throws RejectedExecutionException): this runs on a pool thread with nobody to catch, so drop the
        // answer rather than crash the process.
        try {
            val result = answer(key, seq, ok, reply)
            val out = split(result)?.first ?: result
            if (!isEmpty(out)) changed(key, out)
        } catch (e: Exception) {
            // Nothing to tell the card any more.
        }
    }

    companion object {
        private val POOL = Executors.newCachedThreadPool { r -> Thread(r, "honk-card-request").apply { isDaemon = true } }

        /** The error code a card sees for a failed query. */
        internal fun code(e: Throwable): String = when (e) {
            is ApiException.Gateway -> when (e.code) {
                504 -> "TIMEOUT"
                401, 403, 404 -> "NOT_ALLOWED"
                429 -> "RATE_LIMITED"
                else -> "REQUEST_FAILED"
            }
            is ApiException.NotRegistered -> "NOT_ALLOWED"
            is ApiException.BadResponse -> "REQUEST_FAILED"
            is SocketTimeoutException -> "TIMEOUT"
            is IOException -> "NETWORK"
            else -> "NETWORK"
        }

        /** A result without its `request`, and the request (seq, data); null when the result has none. */
        internal fun split(result: String): Pair<String, Pair<Int, String>>? {
            if (!result.contains("\"request\"")) return null
            val obj = try {
                ApiClient.JSON.parseToJsonElement(result) as? JsonObject
            } catch (e: Exception) {
                null
            } ?: return null
            val req = obj["request"] as? JsonObject ?: return null
            val seq = req["seq"]?.jsonPrimitive?.intOrNull ?: return null
            val data = req["data"]?.jsonPrimitive?.takeIf { it.isString }?.content ?: return null
            return JsonObject(obj - "request").toString() to (seq to data)
        }

        /** A result that says nothing: no tree, no link or copy, nothing logged, not stopped. */
        internal fun isEmpty(result: String): Boolean {
            val obj = try {
                ApiClient.JSON.parseToJsonElement(result).jsonObject
            } catch (e: Exception) {
                return false
            }
            return obj["tree"] is JsonNull && (obj["logs"] as? JsonArray)?.isEmpty() == true && obj["stopped"] is JsonNull &&
                obj["open"] == null && obj["copy"] == null && (obj["prevented"] as? JsonPrimitive)?.booleanOrNull == false
        }
    }
}
