package dev.evumi.honk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.longbridge.nsh.NshHostReply
import com.longbridge.nsh.NshView
import dev.evumi.honk.core.Bot
import dev.evumi.honk.core.ChatSummary
import dev.evumi.honk.core.Gateway
import dev.evumi.honk.core.LocalAvatars
import dev.evumi.honk.core.StoredMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.Base64

/**
 * The host calls the nsh app makes (`host.call("honk.…")`) and the events it
 * receives (`host.on("honk.…")`). The TSX side of this contract is
 * app/src/host.ts and the iOS side ios/App/NshBridge.swift; keep the three in
 * step.
 *
 * Calls: honk.status, honk.chats, honk.messages, honk.markRead, honk.focus,
 * honk.refresh, honk.bot.create, honk.bot.update, honk.bot.token,
 * honk.bot.resetToken, honk.bot.delete, honk.bot.setMuted, honk.bot.setPinned,
 * honk.message.delete, honk.chat.clear, honk.notifications.open, honk.avatar.save, honk.avatar.image,
 * honk.gateway.get, honk.gateway.test, honk.gateway.set, honk.register.retry.
 * Events: honk.changed (the store changed), honk.open { botId } (open a chat).
 *
 * nsh calls the handlers on the UI thread with the JSON arguments as Map,
 * List, String, Number and Boolean; each handler does its work on the IO
 * dispatcher and answers through the NshHostReply, which any thread may do.
 */
class NshBridge(
    private val activity: MainActivity,
    private val nsh: NshView,
    private val service: HonkService,
) {
    private var removeListener: (() -> Unit)? = null

    fun install() {
        removeListener = service.addChangeListener { nsh.send("honk.changed", null) }

        handle("honk.status") { status() }
        handle("honk.register.retry") {
            service.retryRegistration()
            status()
        }
        handle("honk.chats") { service.store.chats().map(::chat) }
        handle("honk.messages") { a ->
            service.store.messages(a.requireString("botId"), a.long("before"), a.long("limit")?.toInt() ?: 50).map(::message)
        }
        handle("honk.markRead") { a ->
            service.markRead(a.requireString("botId"))
            true
        }
        handle("honk.focus") { a ->
            service.focusedBotId = a.string("botId")
            true
        }
        handle("honk.refresh") {
            service.refresh()
            true
        }

        // gateway

        handle("honk.gateway.get") {
            mapOf("url" to service.gatewayUrl, "defaultURL" to service.defaultGatewayUrl, "custom" to service.isCustomGateway)
        }
        handle("honk.gateway.test") { a ->
            try {
                val checked = service.testGateway(a.requireString("url"))
                mapOf("ok" to true, "url" to checked.url, "version" to checked.version)
            } catch (e: Exception) {
                mapOf("ok" to false, "error" to Gateway.describe(e))
            }
        }
        handle("honk.gateway.set") { a ->
            // `url` null or missing: back to the default gateway. Failures reject the call.
            try {
                service.switchGateway(a.string("url"))
            } catch (e: Exception) {
                throw IllegalStateException(Gateway.describe(e), e)
            }
            mapOf("url" to service.gatewayUrl, "registered" to service.isRegistered)
        }

        // bots

        handle("honk.bot.create") { a ->
            val created = service.api.createBot(a.requireString("name"), a.string("avatar").orEmpty(), a.string("defaultLevel") ?: "active")
            service.store.saveBot(created.bot)
            service.botTokens.save(created.bot.id, created.token)
            service.notifier.ensureChannel(created.bot.id, created.bot.name)
            service.changed()
            mapOf("bot" to bot(created.bot), "token" to created.token)
        }
        handle("honk.bot.update") { a ->
            val b = service.api.updateBot(a.requireString("botId"), a.string("name"), a.string("avatar"), a.string("defaultLevel"))
            service.store.saveBot(b)
            service.notifier.ensureChannel(b.id, b.name)
            service.changed()
            bot(b)
        }
        handle("honk.bot.token") { a -> service.botTokens.token(a.requireString("botId")) }
        handle("honk.bot.resetToken") { a ->
            val id = a.requireString("botId")
            service.api.resetToken(id).also { service.botTokens.save(id, it) }
        }
        handle("honk.bot.delete") { a ->
            val id = a.requireString("botId")
            service.api.deleteBot(id)
            service.notifier.cancel(service.store.clearMessages(id))
            service.store.deleteBot(id)
            service.botTokens.remove(id)
            service.notifier.deleteChannel(id)
            service.changed()
            true
        }
        handle("honk.bot.setMuted") { a ->
            service.store.setMuted(a.requireString("botId"), a.bool("muted") ?: false)
            service.changed()
            true
        }
        handle("honk.bot.setPinned") { a ->
            service.store.setPinned(a.requireString("botId"), a.bool("pinned") ?: false)
            service.changed()
            true
        }

        // messages

        // avatars (kept on this phone only)
        handle("honk.avatar.save") { a ->
            val bytes = try {
                Base64.getDecoder().decode(a.requireString("data"))
            } catch (e: IllegalArgumentException) {
                throw LocalAvatars.SaveException(LocalAvatars.NOT_AN_IMAGE)
            }
            Notifier.localAvatars(activity).save(bytes)
        }
        handle("honk.avatar.image") { a -> Notifier.localAvatars(activity).dataUrl(a.requireString("avatar")) ?: JSONObject.NULL }

        handle("honk.message.delete") { a ->
            service.store.deleteMessage(a.require("messageId"))?.let { service.notifier.cancel(listOf(it)) }
            service.changed()
            true
        }
        handle("honk.chat.clear") { a ->
            service.notifier.cancel(service.store.clearMessages(a.requireString("botId")))
            service.changed()
            true
        }
        handle("honk.notifications.open", io = false) {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            activity.startActivity(intent)
            true
        }
    }

    fun uninstall() {
        removeListener?.invoke()
        removeListener = null
    }

    fun openChat(botId: String) {
        nsh.send("honk.open", mapOf("botId" to botId))
    }

    /** The notification permission may have changed (back from settings, the dialog answered). */
    fun statusChanged() {
        nsh.send("honk.changed", null)
    }

    /** honk.status: Android always has a real push channel (FCM), so pushMode is "apns" as on a device. */
    private fun status(): Map<String, Any?> = buildMap {
        put("registered", service.isRegistered)
        put("registration", service.registration.name)
        (service.registration as? HonkService.Registration.Failed)?.let { put("registrationError", it.reason) }
        put("pushMode", "apns")
        put("gatewayURL", service.gatewayUrl)
        put("notifications", notificationStatus())
        put("appVersion", BuildConfig.VERSION_NAME)
        put("appBuild", BuildConfig.VERSION_CODE.toString())
    }

    private fun notificationStatus(): String {
        val granted = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        return when {
            granted && NotificationManagerCompat.from(activity).areNotificationsEnabled() -> "authorized"
            !granted && !activity.askedForNotifications() -> "notDetermined"
            else -> "denied"
        }
    }

    private fun handle(name: String, io: Boolean = true, body: suspend (Args) -> Any?) {
        nsh.handle(name) { data: Any?, reply: NshHostReply ->
            activity.lifecycleScope.launch {
                try {
                    val args = Args(data)
                    val result = if (io) withContext(Dispatchers.IO) { body(args) } else body(args)
                    reply.resolve(result)
                } catch (e: Exception) {
                    reply.reject(e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    // JSON shapes (camelCase; bot ids are strings, message ids numbers), the same as NshBridge.swift.

    private fun bot(b: Bot): Map<String, Any?> =
        mapOf("id" to b.id, "name" to b.name, "avatar" to b.avatar, "defaultLevel" to b.defaultLevel, "createdAt" to b.createdAt)

    private fun message(m: StoredMessage): Map<String, Any?> = mapOf(
        "id" to m.id, "botId" to m.botId, "title" to m.title, "body" to m.body, "html" to m.html, "data" to m.data,
        "level" to m.level, "group" to m.group, "url" to m.url, "copy" to m.copy, "icon" to m.icon,
        "collapseId" to m.collapseId, "date" to m.date, "read" to m.read,
    )

    private fun chat(c: ChatSummary): Map<String, Any?> = mapOf(
        "bot" to bot(c.bot), "muted" to c.muted, "pinned" to c.pinned, "unread" to c.unread,
        // nsh serialises through org.json, whose JSONObject(Map) drops null values: JSONObject.NULL keeps `last: null`.
        "last" to (c.last?.let(::message) ?: JSONObject.NULL),
    )
}

/** Reads the JSON object a host call passes. */
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
