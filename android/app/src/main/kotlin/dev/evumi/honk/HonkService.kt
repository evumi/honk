package dev.evumi.honk

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.evumi.honk.core.ApiClient
import dev.evumi.honk.core.ApiException
import dev.evumi.honk.core.BotTokenStore
import dev.evumi.honk.core.CredentialStore
import dev.evumi.honk.core.DeviceRegistrar
import dev.evumi.honk.core.Gateway
import dev.evumi.honk.core.HttpTransport
import dev.evumi.honk.core.LegacyBotIds
import dev.evumi.honk.core.LocalStore
import dev.evumi.honk.core.PushInfo
import dev.evumi.honk.core.QueuedMessage
import dev.evumi.honk.core.SyncEngine
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's single owner of credentials, the local store and the gateway
 * client, shared by the activity (through the nsh bridge) and the FCM service.
 * The counterpart of ios/App/HonkService.swift. Methods that talk to the
 * gateway or Firebase block: call them off the main thread.
 */
class HonkService private constructor(context: Context) {
    val context: Context = context.applicationContext
    val credentials: CredentialStore
    val botTokens: BotTokenStore
    val store: LocalStore = LocalStore(AndroidSql(File(this.context.noBackupFilesDir, "honk.sqlite")))
    val notifier = Notifier(this.context)
    private val prefs: SharedPreferences = this.context.getSharedPreferences("honk", Context.MODE_PRIVATE)

    /** Where registration with the gateway stands; the settings page shows it. */
    sealed class Registration(val name: String) {
        object WaitingForPushToken : Registration("waitingForPushToken")
        object Registering : Registration("registering")
        object Registered : Registration("registered")
        class Failed(val reason: String) : Registration("failed")
    }

    @Volatile var registration: Registration = Registration.WaitingForPushToken
        private set

    /** The bot whose chat is on screen while the activity is resumed; its messages show no notification. */
    @Volatile var focusedBotId: String? = null
    @Volatile var foreground = false
    /** A message arrived while the app is open (not for the open chat): the app shows its own banner. Main thread. */
    @Volatile var onIncoming: ((botId: String, messageId: Long) -> Unit)? = null

    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val main = Handler(Looper.getMainLooper())
    private val syncing = AtomicBoolean(false)

    init {
        val secure = SecurePrefs.open(this.context)
        credentials = PrefsCredentialStore(secure)
        botTokens = PrefsBotTokenStore(secure)
        if (credentials.load() != null) registration = Registration.Registered
    }

    // gateway address

    /** The gateway the build was configured with (BuildConfig.GATEWAY_URL). */
    val defaultGatewayUrl: String = Gateway.normalize(BuildConfig.GATEWAY_URL) ?: "http://10.0.2.2:8080/"

    /** The gateway in use: the user's choice, else the build's default. */
    val gatewayUrl: String
        get() = prefs.getString(KEY_GATEWAY, null)?.let(Gateway::normalize) ?: defaultGatewayUrl

    val isCustomGateway: Boolean get() = gatewayUrl != defaultGatewayUrl

    val api: ApiClient get() = ApiClient(gatewayUrl, credentials.load()?.secret)
    val isRegistered: Boolean get() = credentials.load() != null

    /** Calls [listener] on the main thread whenever the store or the registration changed. Returns a function that removes it. */
    fun addChangeListener(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    /** The store changed: tell the UI. Any thread. */
    fun changed() {
        main.post { listeners.forEach { it() } }
    }

    private fun setRegistration(r: Registration) {
        registration = r
        changed()
    }

    // registration

    /** Registers the device or sends a new FCM token; the gateway's 401 means register again. Blocking. */
    fun register(pushToken: String) {
        prefs.edit().putString(KEY_LAST_PUSH_TOKEN, pushToken).apply()
        if (registration != Registration.Registered) setRegistration(Registration.Registering)
        try {
            val r = DeviceRegistrar(gatewayUrl, credentials).register(pushToken)
            setRegistration(Registration.Registered)
            if (r == DeviceRegistrar.Result.REGISTERED) refresh()
        } catch (e: Exception) {
            Log.w(TAG, "register failed", e)
            setRegistration(Registration.Failed(Gateway.describe(e)))
        }
    }

    /** The current FCM token. Blocking, at most 20 seconds. */
    private fun fetchPushToken(): String {
        if (!BuildConfig.HAS_FIREBASE || FirebaseApp.getApps(context).isEmpty()) {
            throw IOException("这个构建没有 Firebase 配置（android/app/google-services.json），拿不到推送 token")
        }
        return Tasks.await(FirebaseMessaging.getInstance().token, 20, TimeUnit.SECONDS)
    }

    /** Asks Firebase for the current token and registers with it, on a background thread. */
    fun registerWithCurrentToken() {
        Thread { registerWithFreshToken() }.start()
    }

    private fun registerWithFreshToken() {
        val token = try {
            fetchPushToken()
        } catch (e: Exception) {
            Log.w(TAG, "no FCM token", e)
            if (registration != Registration.Registered) {
                setRegistration(Registration.Failed("无法取得推送 token：${Gateway.describe(e.cause ?: e)}。检查网络和 Google Play 服务后重试。"))
            }
            return
        }
        register(token)
    }

    /**
     * Tries registration again: checks the stored device, else registers with
     * the last push token, else asks Firebase for one. Blocking; returns once
     * it settles.
     */
    fun retryRegistration() {
        if (credentials.load() != null) {
            try {
                api.listBots()
                setRegistration(Registration.Registered)
                return
            } catch (e: ApiException) {
                if (!e.isUnauthorized) {
                    setRegistration(Registration.Failed(Gateway.describe(e)))
                    return
                }
                credentials.clear()
            } catch (e: Exception) {
                setRegistration(Registration.Failed(Gateway.describe(e)))
                return
            }
        }
        prefs.getString(KEY_LAST_PUSH_TOKEN, null)?.let {
            register(it)
            return
        }
        setRegistration(Registration.WaitingForPushToken)
        registerWithFreshToken()
    }

    // switching gateways

    /** Checks that [address] answers as a Honk gateway. Blocking. */
    fun testGateway(address: String): Gateway.Checked = Gateway.check(address)

    /**
     * Moves the device to another gateway (null: the build's default). The new
     * gateway knows nothing of this device, so its local data goes and it
     * registers again; the bots on the old gateway stay there. Blocking.
     */
    fun switchGateway(address: String?) {
        val target = if (address == null) defaultGatewayUrl else testGateway(address).url
        if (target == gatewayUrl) return
        val pushToken = credentials.load()?.pushToken
        prefs.edit().apply {
            if (target == defaultGatewayUrl) remove(KEY_GATEWAY) else putString(KEY_GATEWAY, target)
        }.commit()
        credentials.clear()
        botTokens.removeAll()
        notifier.cancel(store.reset())
        notifier.syncChannels(emptyList())
        changed()
        setRegistration(Registration.WaitingForPushToken)
        if (pushToken != null) register(pushToken) else retryRegistration()
    }

    // sync

    /** Fetches the bot list and anything queued, then refreshes the UI. Blocking. */
    fun refresh() {
        if (!isRegistered || !syncing.compareAndSet(false, true)) return
        try {
            val client = api
            val bots = client.listBots()
            // Bots still stored by integer id move to their short id; one whose
            // rename failed for now (offline, 5xx) is kept for the next refresh.
            val renamed = LegacyBotIds.rename(store, botTokens, bots) { client.getMe(it) }
            renamed.renamed.forEach { notifier.moveChannel(it.old, it.new) }
            store.replaceBots(bots, keeping = renamed.pending)
            notifier.syncChannels(store.chats().map { it.bot })
            val out = SyncEngine(api, store).run()
            notifier.cancel(out.staleNotificationIds)
            Notifier.localAvatars(context).prune(store.chats().map { it.bot.avatar }.toSet())
        } catch (e: ApiException) {
            Log.w(TAG, "refresh failed", e)
            if (e.isUnauthorized) {
                // The gateway forgot this device (it was deleted): register again.
                credentials.clear()
                setRegistration(Registration.WaitingForPushToken)
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

    /**
     * The app may not have synced since the gateway gave its bots short ids:
     * rename first so the push's bot name, avatar and mute apply. A short
     * timeout keeps a slow gateway from holding up the notification.
     */
    private fun renameBeforePush() {
        if (!isRegistered) return
        val client = ApiClient(gatewayUrl, credentials.load()?.secret, HttpTransport(timeoutMs = 5_000))
        LegacyBotIds.renameBeforePush(store, botTokens, client).renamed.forEach { notifier.moveChannel(it.old, it.new) }
    }

    private fun handleMessage(info: PushInfo) {
        renameBeforePush()
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
        val incoming = onIncoming
        if (foreground && incoming != null) {
            // The app is open: it shows its own banner instead of a notification.
            main.post { incoming(info.botId, info.messageId) }
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
        renameBeforePush()
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

    /**
     * Marks a bot's messages read. Announces a change only when something was
     * unread: the chat page reloads on changes and marks read on load, so an
     * unconditional announcement would loop.
     */
    fun markRead(botId: String) {
        if (store.unreadCount(botId) == 0) return
        notifier.cancel(store.markRead(botId))
        changed()
    }

    companion object {
        private const val TAG = "honk"
        private const val KEY_GATEWAY = "gatewayURL"
        private const val KEY_LAST_PUSH_TOKEN = "lastPushToken"
        @Volatile private var instance: HonkService? = null

        fun get(context: Context): HonkService =
            instance ?: synchronized(this) { instance ?: HonkService(context).also { instance = it } }
    }
}
