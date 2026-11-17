package dev.evumi.honk

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.evumi.honk.core.ApiClient
import dev.evumi.honk.core.ApiException
import dev.evumi.honk.core.BotTokenStore
import dev.evumi.honk.core.CredentialStore
import dev.evumi.honk.core.DeviceRegistrar
import dev.evumi.honk.core.LocalStore
import dev.evumi.honk.core.PushInfo
import dev.evumi.honk.core.QueuedMessage
import dev.evumi.honk.core.SyncEngine
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's single owner of credentials, the local store and the gateway
 * client, shared by the activity (through the nsh bridge) and the FCM service.
 * The counterpart of ios/App/HonkService.swift. Methods that talk to the
 * gateway block: call them off the main thread.
 */
class HonkService private constructor(context: Context) {
    val context: Context = context.applicationContext
    val gatewayUrl: String = BuildConfig.GATEWAY_URL
    val credentials: CredentialStore
    val botTokens: BotTokenStore
    val store: LocalStore = LocalStore(AndroidSql(File(this.context.noBackupFilesDir, "honk.sqlite")))
    val notifier = Notifier(this.context)

    /** The bot whose chat is on screen while the activity is resumed; its messages show no notification. */
    @Volatile var focusedBotId: Long? = null
    @Volatile var foreground = false

    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val syncing = AtomicBoolean(false)

    init {
        val prefs = SecurePrefs.open(this.context)
        credentials = PrefsCredentialStore(prefs)
        botTokens = PrefsBotTokenStore(prefs)
    }

    val api: ApiClient get() = ApiClient(gatewayUrl, credentials.load()?.secret)
    val isRegistered: Boolean get() = credentials.load() != null

    /** Calls [listener] on the main thread whenever the store changed. Returns a function that removes it. */
    fun addChangeListener(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    /** The store changed: tell the UI. Any thread. */
    fun changed() {
        main.post { listeners.forEach { it() } }
    }

    // registration

    /** Registers the device or sends a new FCM token; the gateway's 401 means register again. */
    fun register(pushToken: String) {
        try {
            val r = DeviceRegistrar(gatewayUrl, credentials).register(pushToken)
            if (r == DeviceRegistrar.Result.REGISTERED) refresh()
        } catch (e: Exception) {
            Log.w(TAG, "register failed", e)
        }
    }

    /** Asks Firebase for the current token and registers with it. Any thread. */
    fun registerWithCurrentToken() {
        if (!BuildConfig.HAS_FIREBASE || FirebaseApp.getApps(context).isEmpty()) {
            Log.w(TAG, "no Firebase configuration (android/app/google-services.json): no push token")
            return
        }
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token -> Thread { register(token) }.start() }
            .addOnFailureListener { Log.w(TAG, "no FCM token", it) }
    }

    // sync

    /** Fetches the bot list and anything queued, then refreshes the UI. Blocking. */
    fun refresh() {
        if (!isRegistered || !syncing.compareAndSet(false, true)) return
        try {
            store.replaceBots(api.listBots())
            notifier.syncChannels(store.chats().map { it.bot })
            val out = SyncEngine(api, store).run()
            notifier.cancel(out.staleNotificationIds)
        } catch (e: ApiException) {
            Log.w(TAG, "refresh failed", e)
            if (e.isUnauthorized) {
                // The gateway forgot this device (it was deleted): register again.
                credentials.clear()
                registerWithCurrentToken()
            }
        } catch (e: Exception) {
            Log.w(TAG, "refresh failed", e)
        } finally {
            syncing.set(false)
        }
        changed()
    }

    // pushes

    /**
     * Handles an FCM data message (gateway/internal/push/fcm.go). A message is
     * fetched, stored and shown; an edit or delete is fetched and applied, and
     * a notification it makes stale is removed. Blocking.
     */
    fun handlePush(info: PushInfo) {
        when (info.kind) {
            QueuedMessage.Kind.MESSAGE -> handleMessage(info)
            else -> handleSilent(info)
        }
    }

    private fun handleMessage(info: PushInfo) {
        val tag = Notifier.tag(info.botId, info.messageId, info.collapseId)
        val stored = try {
            val r = store.apply(api.message(info.messageId), tag)
            notifier.cancel(r.staleNotificationIds)
            r.message
        } catch (e: Exception) {
            // Offline, not registered, or already gone from the queue: show the push's own text.
            Log.w(TAG, "fetch message ${info.messageId} failed", e)
            null
        }
        changed()
        if (foreground && focusedBotId == info.botId) {
            // The chat is open: the message appears there, no notification.
            notifier.cancel(store.markRead(info.botId))
            changed()
            return
        }
        val bot = store.bot(info.botId)
        notifier.show(
            Notifier.Content(
                botId = info.botId,
                botName = bot?.name ?: info.botName.ifEmpty { "Honk" },
                avatar = stored?.icon?.takeIf { it.isNotEmpty() } ?: bot?.avatar.orEmpty(),
                messageId = info.messageId,
                tag = tag,
                title = stored?.title ?: info.title,
                body = stored?.body ?: info.body,
                group = stored?.group ?: info.group,
                level = stored?.level?.takeIf { it.isNotEmpty() } ?: info.level,
                date = stored?.date?.takeIf { it > 0 } ?: System.currentTimeMillis(),
                muted = store.isMuted(info.botId),
            ),
        )
    }

    private fun handleSilent(info: PushInfo) {
        if (!isRegistered) return
        try {
            val r = store.apply(api.message(info.messageId))
            notifier.cancel(r.staleNotificationIds)
            changed()
        } catch (e: Exception) {
            // Gone from the queue already (a sync applied it) or offline: sync instead.
            refresh()
        }
    }

    // local changes

    fun markRead(botId: Long) {
        notifier.cancel(store.markRead(botId))
        changed()
    }

    companion object {
        private const val TAG = "honk"
        @Volatile private var instance: HonkService? = null

        fun get(context: Context): HonkService =
            instance ?: synchronized(this) { instance ?: HonkService(context).also { instance = it } }
    }
}
