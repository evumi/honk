package dev.evumi.honk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.longbridge.nsh.NshHostReply
import com.longbridge.nsh.NshView
import dev.evumi.honk.core.ApiClient
import dev.evumi.honk.core.Args
import dev.evumi.honk.core.CardHost
import dev.evumi.honk.core.CardRequests
import dev.evumi.honk.core.Gateway
import dev.evumi.honk.core.HostArgs
import dev.evumi.honk.core.HostJson
import dev.evumi.honk.core.HttpTransport
import dev.evumi.honk.core.LocalAvatars
import dev.evumi.honk.core.MessageArchive
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.Base64

/**
 * The host calls the nsh app makes (`host.call("honk.…")`) and the events it
 * receives (`host.on("honk.…")`). The TSX side of this contract is
 * app/src/host.ts and the iOS side ios/App/NshBridge.swift; keep the three in
 * step.
 *
 * Calls: honk.status, honk.chats, honk.messages, honk.search, honk.markRead, honk.focus,
 * honk.refresh, honk.retention.get, honk.retention.set, honk.export, honk.import, honk.bot.create, honk.bot.update, honk.bot.token,
 * honk.bot.resetToken, honk.bot.delete, honk.bot.setMuted, honk.bot.setPinned,
 * honk.message.delete, honk.chat.clear, honk.device.delete, honk.devices.list, honk.devices.remove,
 * honk.link.create, honk.link.claim, honk.notifications.open, honk.avatar.save, honk.avatar.image,
 * honk.gateway.get, honk.gateway.test, honk.gateway.set, honk.register.retry.
 * Card scripts: honk.card.open, honk.card.click, honk.card.set, honk.card.close.
 * Events: honk.changed (the store changed), honk.open { botId } (open a chat),
 * honk.incoming { botId, messageId } (a message arrived while the app is open; it shows its own banner),
 * honk.card.changed { key, result } (a card's timer changed it).
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

    // Card scripts run on their own thread, each in a QuickJS runtime (native/card);
    // the strings in and out are JSON the app reads. Timer changes go to the UI thread.
    private val cards = CardHost { key, result ->
        activity.runOnUiThread { nsh.send("honk.card.changed", HostJson.cardChangedEvent(key, result)) }
    }

    // A card's request(): the host sends it to the message's bot itself and gives the card the answer;
    // the app sees neither (the result it gets has no `request`). The gateway waits up to 15 s for the bot.
    private val requests = CardRequests(
        query = { messageId, data ->
            ApiClient(service.gatewayUrl, service.credentials.load()?.secret, HttpTransport(timeoutMs = 20_000)).query(messageId, data)
        },
        answer = { key, seq, ok, data -> cards.answer(key, seq, ok, data) },
        changed = { key, result -> activity.runOnUiThread { nsh.send("honk.card.changed", HostJson.cardChangedEvent(key, result)) } },
    )

    fun install() {
        removeListener = service.addChangeListener { nsh.send("honk.changed", null) }
        // Only once the app listens: until then pushes get a system notification.
        handle("honk.incoming.listen") {
            service.onIncoming = { botId, messageId -> nsh.send("honk.incoming", HostJson.incomingEvent(botId, messageId)) }
            true
        }

        handle("honk.card.open") { a ->
            HostArgs.CardCall(a, "load").let {
                requests.opened(it.key, it.payload)
                cards.open(it.key, it.payload)
            }
        }
        handle("honk.card.click") { a -> HostArgs.CardCall(a, "path").let { requests.filter(it.key, cards.click(it.key, it.payload)) } }
        handle("honk.card.set") { a -> HostArgs.CardCall(a, "state").let { cards.set(it.key, it.payload) } }
        handle("honk.card.close") { a ->
            val key = HostArgs.CardCall(a, null).key
            requests.closed(key)
            cards.close(key)
            true
        }

        handle("honk.status") { status() }
        handle("honk.register.retry") {
            service.retryRegistration()
            status()
        }
        handle("honk.chats") { service.store.chats().map(HostJson::chat) }
        handle("honk.messages") { a ->
            HostArgs.Messages(a).let {
                // `around`: a window around that message (a search result opened in its chat).
                val around = it.around
                if (around != null) service.store.messagesAround(it.botId, around, it.limit)
                else service.store.messages(it.botId, it.before, it.limit)
            }.map(HostJson::message)
        }
        handle("honk.search") { a -> HostArgs.Search(a).let { service.store.search(it.query, it.before) }.map(HostJson::message) }

        // retention, export and import

        handle("honk.retention.get") { service.store.retentionDays }
        handle("honk.retention.set") { a ->
            service.store.retentionDays = HostArgs.RetentionSet(a).days
            service.pruneExpired()
            service.changed()
            service.store.retentionDays
        }
        handle("honk.export") { a ->
            // One chat, or every chat when `botId` is missing: written to the cache and offered in the share sheet.
            val botId = HostArgs.Export(a).botId
            val messages = service.store.exportMessages(botId)
            if (messages.isEmpty()) {
                HostJson.exportResult(0, false)
            } else {
                val name = MessageArchive.fileName(botId?.let { service.store.bot(it)?.name })
                val dir = File(activity.cacheDir, "exports").apply { deleteRecursively(); mkdirs() }
                val file = File(dir, name).apply { writeText(MessageArchive.encode(messages)) }
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.exports", file)
                val send = Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                withContext(Dispatchers.Main) {
                    activity.startActivity(Intent.createChooser(send, activity.getString(R.string.export_messages)))
                }
                // The share sheet gives no result: it is on screen, which is all the app can know.
                HostJson.exportResult(messages.size, true)
            }
        }
        handle("honk.import") {
            // Picks a file and adds its messages; null when the user cancels.
            val uri = activity.pickDocument()
            if (uri == null) {
                null
            } else {
                val bytes = activity.contentResolver.openInputStream(uri)?.use { input ->
                    val out = java.io.ByteArrayOutputStream()
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > MAX_IMPORT_BYTES) throw IllegalArgumentException("the file is larger than 64 MB")
                    }
                    out.toByteArray()
                } ?: throw IllegalArgumentException("cannot read the file")
                val archive = MessageArchive.decode(String(bytes, Charsets.UTF_8))
                val r = service.store.importMessages(archive.messages)
                service.changed()
                HostJson.importResult(r, archive.invalid)
            }
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
            HostJson.gatewayGet(service.gatewayUrl, service.defaultGatewayUrl, service.isCustomGateway, service.registerKey.orEmpty())
        }
        handle("honk.gateway.test") { a ->
            try {
                val checked = service.testGateway(a.requireString("url"))
                HostJson.gatewayTest(checked.url, checked.version, checked.registerKeyRequired, checked.push)
            } catch (e: Exception) {
                HostJson.gatewayTestFailed(Gateway.describe(e))
            }
        }
        handle("honk.gateway.set") { a ->
            // `url` null or missing: back to the default gateway; `registerKey` missing or empty: none.
            // Failures reject the call.
            val g = HostArgs.GatewaySet(a)
            try {
                service.switchGateway(g.url, g.registerKey)
            } catch (e: Exception) {
                throw IllegalStateException(Gateway.describe(e), e)
            }
            HostJson.gatewaySet(service.gatewayUrl, service.isRegistered)
        }

        // bots

        handle("honk.bot.create") { a ->
            val c = HostArgs.BotCreate(a)
            // After the device's data was deleted, the first bot registers it again.
            if (!service.isRegistered) service.retryRegistration()
            val created = service.api.createBot(c.name, c.avatar, c.defaultLevel)
            service.store.saveBot(created.bot)
            service.botTokens.save(created.bot.id, created.token)
            service.notifier.ensureChannel(created.bot.id, created.bot.name)
            service.changed()
            HostJson.botCreated(created.bot, created.token)
        }
        handle("honk.bot.update") { a ->
            val u = HostArgs.BotUpdate(a)
            val b = service.api.updateBot(u.botId, u.name, u.avatar, u.defaultLevel)
            service.store.saveBot(b)
            service.notifier.ensureChannel(b.id, b.name)
            service.changed()
            HostJson.bot(b)
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
        handle("honk.device.delete") {
            service.deleteDeviceData()
            true
        }
        handle("honk.devices.list") { service.listDevices().map { HostJson.device(it) } }
        handle("honk.devices.remove") { a ->
            service.removeDevice(a.requireString("deviceId"))
            true
        }
        handle("honk.link.create") {
            val c = service.createLink()
            HostJson.linkCreated(c.code, c.expiresAt)
        }
        handle("honk.link.claim") { a ->
            service.claimLink(a.requireString("code"))
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
        cards.shutdown()
        removeListener?.invoke()
        removeListener = null
        service.onIncoming = null
    }

    fun openChat(botId: String) {
        nsh.send("honk.open", HostJson.openEvent(botId))
    }

    /** The notification permission may have changed (back from settings, the dialog answered). */
    fun statusChanged() {
        nsh.send("honk.changed", null)
    }

    /** honk.status: Android always has a real push channel (FCM), so pushMode is "apns" as on a device. */
    private fun status(): Map<String, Any?> = HostJson.status(
        registered = service.isRegistered,
        registration = service.registration.name,
        registrationError = (service.registration as? HonkService.Registration.Failed)?.reason,
        pushMode = "apns",
        gatewayUrl = service.gatewayUrl,
        notifications = notificationStatus(),
        appVersion = BuildConfig.VERSION_NAME,
        appBuild = BuildConfig.VERSION_CODE.toString(),
    )

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
                    reply.resolve(orgJson(result))
                } catch (e: Exception) {
                    reply.reject(e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    /**
     * nsh serialises through org.json, whose JSONObject(Map) drops null values
     * (`last: null` would vanish): JSONObject.NULL keeps them. The shapes come
     * from HostJson in :core, the same as HostJSON in ios/HonkKit.
     */
    private fun orgJson(v: Any?): Any? = when (v) {
        is Map<*, *> -> v.entries.associate { (k, x) -> k to (orgJson(x) ?: JSONObject.NULL) }
        is List<*> -> v.map { orgJson(it) ?: JSONObject.NULL }
        else -> v
    }
}

private const val MAX_IMPORT_BYTES = 64 * 1024 * 1024
