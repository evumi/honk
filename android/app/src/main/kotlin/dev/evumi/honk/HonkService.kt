package dev.evumi.honk

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.evumi.honk.core.ApiClient
import dev.evumi.honk.core.ApiException
import dev.evumi.honk.core.Banner
import dev.evumi.honk.core.Deadline
import dev.evumi.honk.core.SecretPruning
import dev.evumi.honk.core.StoredMessage
import dev.evumi.honk.core.TimeBox
import dev.evumi.honk.core.BotKeyStore
import dev.evumi.honk.core.GroupKeyStore
import dev.evumi.honk.core.KeyRing
import dev.evumi.honk.core.Seal
import dev.evumi.honk.core.BotTokenStore
import dev.evumi.honk.core.CredentialStore
import dev.evumi.honk.core.DeviceLinking
import dev.evumi.honk.core.DeviceRegistrar
import dev.evumi.honk.core.Gateway
import dev.evumi.honk.core.HttpTransport
import dev.evumi.honk.core.LegacyBotIds
import dev.evumi.honk.core.LocalStore
import dev.evumi.honk.core.NotificationPlan
import dev.evumi.honk.core.MessageOpener
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
    /** Each bot's end-to-end key; with [opener] it decrypts what the queue delivers. */
    val botKeys: BotKeyStore
    /** The group key, which wraps each bot's key for the gateway so the group's other devices can unwrap it. */
    val groupKey: GroupKeyStore
    val keyRing: KeyRing
    val opener: MessageOpener
    val store: LocalStore = LocalStore(AndroidSql(File(this.context.noBackupFilesDir, "honk.sqlite")))
    val notifier = Notifier(this.context)
    private val prefs: SharedPreferences = this.context.getSharedPreferences("honk", Context.MODE_PRIVATE)
    private val secure: SharedPreferences = SecurePrefs.open(this.context)

    /** Where registration with the gateway stands; the settings page shows it. */
    sealed class Registration(val name: String) {
        /** The device's data was deleted; it registers again when a bot is created or the app starts. */
        object NotRegistered : Registration("notRegistered")
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
        credentials = PrefsCredentialStore(secure)
        botTokens = PrefsBotTokenStore(secure)
        botKeys = PrefsBotKeyStore(secure)
        groupKey = PrefsGroupKeyStore(secure)
        keyRing = KeyRing(botKeys, groupKey)
        opener = MessageOpener(botKeys, this.context.getString(R.string.undecryptable_notification))
        if (credentials.load() != null) registration = Registration.Registered
    }

    // gateway address

    /** The gateway the build was configured with (BuildConfig.GATEWAY_URL). */
    val defaultGatewayUrl: String = Gateway.normalize(BuildConfig.GATEWAY_URL) ?: "http://10.0.2.2:8080/"

    /** The gateway in use: the user's choice, else the build's default. */
    val gatewayUrl: String
        get() = prefs.getString(KEY_GATEWAY, null)?.let(Gateway::normalize) ?: defaultGatewayUrl

    val isCustomGateway: Boolean get() = gatewayUrl != defaultGatewayUrl

    /** The register key of the gateway, when it asks for one (HONK_REGISTER_KEY); sent when registering. */
    var registerKey: String?
        get() = secure.getString(KEY_REGISTER_KEY, null)?.takeIf { it.isNotEmpty() }
        private set(v) {
            secure.edit().apply { if (v.isNullOrEmpty()) remove(KEY_REGISTER_KEY) else putString(KEY_REGISTER_KEY, v) }.commit()
        }

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

    /** The gateway no longer knows this device: drop its credentials and the group key (see [register]). */
    private fun forgetDevice() {
        credentials.clear()
        groupKey.remove()
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
            val r = DeviceRegistrar(
                gatewayUrl, credentials, registerKey = registerKey, deviceName = Build.MODEL,
                // A new, unrelated group must not reuse the old group's key.
                onForgotten = { groupKey.remove() },
            ).register(pushToken)
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
                forgetDevice()
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
     * registers again; the bots on the old gateway stay there. [registerKey]
     * is the key that gateway asks for when registering, if any; it replaces
     * the saved one. With the same gateway only the key changes. Blocking.
     */
    fun switchGateway(address: String?, registerKey: String? = null) {
        val target = if (address == null) defaultGatewayUrl else testGateway(address).url
        // Only after the address checked out, so a typo never changes the key.
        this.registerKey = registerKey
        if (target == gatewayUrl) {
            // Only the key may have changed: a device that could not register may now.
            if (!isRegistered) retryRegistration()
            return
        }
        val pushToken = credentials.load()?.pushToken
        prefs.edit().apply {
            if (target == defaultGatewayUrl) remove(KEY_GATEWAY) else putString(KEY_GATEWAY, target)
        }.commit()
        clearAccountData()
        changed()
        setRegistration(Registration.WaitingForPushToken)
        if (pushToken != null) register(pushToken) else retryRegistration()
    }

    /**
     * Forgets everything this phone keeps for the account: the device
     * credentials, the bot tokens, the messages, the notifications shown for
     * them, and the bots' channels and shortcuts.
     */
    private fun clearAccountData() {
        credentials.clear()
        botTokens.removeAll()
        botKeys.removeAll()
        groupKey.remove()
        notifier.cancel(store.reset())
        notifier.syncChannels(emptyList())
    }

    // deleting this device's data

    /**
     * Deletes everything: on the gateway this device's whole group (every
     * device, the bots and the queued messages), then clears the phone:
     * account data as when switching gateway, plus the avatars and every
     * notification. When the gateway cannot be reached nothing local is
     * touched and this throws. It does not register again: that happens when
     * a bot is created next (`honk.bot.create`) or the app starts again
     * (HonkApp). Blocking.
     */
    fun deleteDeviceData() = leave(all = true)

    /**
     * Takes this phone out of its device group: the gateway forgets this device
     * (the group's bots stay for the others; with no other device it is the
     * same as deleting everything), then the phone is cleared as above. Blocking.
     */
    fun leaveGroup() = leave(all = false)

    private fun leave(all: Boolean) {
        if (credentials.load() != null) {
            try {
                api.deleteDevice(all)
            } catch (e: ApiException) {
                // A 401: the gateway had forgotten this device already.
                if (!e.isUnauthorized) throw IllegalStateException(Gateway.describe(e), e)
            } catch (e: Exception) {
                throw IllegalStateException(Gateway.describe(e), e)
            }
        }
        clearAccountData()
        Notifier.localAvatars(context).removeAll()
        notifier.cancelAll()
        setRegistration(Registration.NotRegistered)
    }

    // device group

    /** The devices of this phone's group; none when it is not registered. Blocking. */
    fun listDevices(): List<ApiClient.GroupDevice> = if (isRegistered) api.listDevices() else emptyList()

    /** Removes a device from the group. This phone's own id leaves the group. Blocking. */
    fun removeDevice(id: String) {
        if (credentials.load()?.deviceId == id) leaveGroup() else api.removeDevice(id)
        changed()
    }

    /** A pairing code for another phone, with this phone's bot tokens sealed in it. Blocking. */
    fun createLink(): DeviceLinking.Created =
        // The bundle carries the group key (made now if this is the first pairing) and the bot keys.
        DeviceLinking.create(
            api, store, botTokens,
            keys = keyRing.bundleKeys(store.botIds()), groupKey = Seal.encode(keyRing.ensureGroupKey()),
        )

    /**
     * Joins the group that made [code]: stores the tokens it holds, then
     * refreshes (the merged bot list and queue). The gateway merges this
     * phone's own bots into that group. Blocking.
     */
    fun claimLink(code: String) {
        if (!isRegistered) retryRegistration()
        // Adopt the creator's group key and bot keys; the refresh after this re-wraps
        // this phone's own encrypted bots with it (KeyRing.reconcile).
        keyRing.adopt(DeviceLinking.claim(code, api, store, botTokens))
        refresh()
    }

    // sync

    /**
     * Deletes the messages older than the retention period the user chose in Settings (default: keep forever).
     * At start and on every refresh. Blocking. Returns whether anything went.
     */
    fun pruneExpired(): Boolean {
        val ids = try {
            store.pruneExpired()
        } catch (e: Exception) {
            Log.w(TAG, "prune failed", e)
            return false
        }
        notifier.cancel(ids)
        return ids.isNotEmpty()
    }

    /**
     * The queued item, decrypted. When it does not open, another device of the
     * group may have turned encryption on or reset the key: unwrap what the
     * gateway holds and try again. Blocking.
     */
    private fun fetchOpened(messageId: Long): QueuedMessage? {
        val item = quickApi(FETCH_TIMEOUT_MS).message(messageId)
        // At most every few minutes: a message that stays unopenable must not cost a bot list each time.
        // (A placeholder is repaired when a sync applies the message again.)
        if (!opener.opens(item) && runCatching { store.claimSlot("key-refresh", KEY_REFRESH_INTERVAL_MS) }.getOrDefault(false)) refreshKeys()
        return opener.open(item)
    }

    /** A client whose every request gives up after [timeoutMs]: a push has a time budget, not the app's 15 s per call. */
    private fun quickApi(timeoutMs: Int) = ApiClient(gatewayUrl, credentials.load()?.secret, HttpTransport(timeoutMs = timeoutMs))

    /** Fetches the bot list and reconciles the keys with the gateway's wrapped ones. A short timeout; failures are ignored. */
    private fun refreshKeys() {
        try {
            val client = ApiClient(gatewayUrl, credentials.load()?.secret, HttpTransport(timeoutMs = 5_000))
            keyRing.reconcile(client.listBots()) { id, wrapped -> client.updateBot(id, keyWrapped = wrapped) }
        } catch (e: Exception) {
            Log.w(TAG, "key refresh failed", e)
        }
    }

    /** Fetches the bot list and anything queued, then refreshes the UI. Blocking. */
    fun refresh() {
        if (!isRegistered || !syncing.compareAndSet(false, true)) return
        try {
            pruneExpired()
            val client = api
            val bots = client.listBots()
            // Bots still stored by integer id move to their short id; one whose
            // rename failed for now (offline, 5xx) is kept for the next refresh.
            val renamed = LegacyBotIds.rename(store, botTokens, bots) { client.getMe(it) }
            renamed.renamed.forEach { notifier.moveChannel(it.old, it.new) }
            store.replaceBots(bots, keeping = renamed.pending)
            // Tokens and keys of bots the gateway no longer lists (deleted elsewhere, another group).
            SecretPruning.prune(store, botTokens, botKeys)
            // Keys other devices turned on or reset arrive here; ours are published.
            keyRing.reconcile(bots) { id, wrapped -> client.updateBot(id, keyWrapped = wrapped) }
            notifier.syncChannels(store.chats().map { it.bot })
            val out = SyncEngine(api, store, opener).run()
            notifier.cancel(out.staleNotificationIds)
            pruneExpired()
            Notifier.localAvatars(context).prune(store.chats().map { it.bot.avatar }.toSet())
        } catch (e: ApiException) {
            Log.w(TAG, "refresh failed", e)
            if (e.isUnauthorized) {
                // The gateway forgot this device (it was deleted): register again.
                forgetDevice()
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
     * a notification it makes stale is removed. Blocking, and within [PUSH_BUDGET_MS]: FCM gives a high-priority
     * message about 20 s.
     */
    fun handlePush(info: PushInfo) {
        when {
            info.kind == QueuedMessage.Kind.MESSAGE && NotificationPlan.shouldNotify(info.silent) -> handleMessage(info)
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
        val client = quickApi(5_000)
        LegacyBotIds.renameBeforePush(store, botTokens, client).renamed.forEach { notifier.moveChannel(it.old, it.new) }
    }

    /** What the network part of a push produced: the notification's tag and the stored message, if any. */
    private class Fetched(val tag: String, val stored: StoredMessage?)

    /**
     * The network part of a message push: rename legacy ids, fetch the message (decrypting it), store it. The
     * message comes first: its collapse id (a push without content has none) decides the notification's tag,
     * which store.apply records. A sealed message is decrypted here; one that cannot be opened is stored as a
     * placeholder and the notification says so.
     */
    private fun fetchAndStore(info: PushInfo): Fetched {
        renameBeforePush()
        val fetched = try {
            fetchOpened(info.messageId)
        } catch (e: Exception) {
            // Offline, not registered, or already gone from the queue: show the push's own text.
            Log.w(TAG, "fetch message ${info.messageId} failed", e)
            null
        }
        val tag = Notifier.tag(info.botId, info.messageId, fetched?.collapseId ?: info.collapseId)
        val stored = fetched?.let {
            try {
                val r = store.apply(it, tag)
                notifier.cancel(r.staleNotificationIds)
                r.message
            } catch (e: Exception) {
                Log.w(TAG, "store message ${info.messageId} failed", e)
                null
            }
        }
        return Fetched(tag, stored)
    }

    private fun handleMessage(info: PushInfo) {
        val deadline = Deadline(PUSH_BUDGET_MS)
        // The network part gets its own time box, so a slow gateway cannot eat the whole budget: at the end of
        // it the notification is shown from the push's own text, and the images get what is left.
        val work = try {
            TimeBox.run(PUSH_BUDGET_MS - IMAGE_BUDGET_MS, "honk-push") { fetchAndStore(info) }
        } catch (e: Exception) {
            Log.w(TAG, "push ${info.messageId} failed", e)
            null
        }
        val tag = work?.tag ?: Notifier.tag(info.botId, info.messageId, info.collapseId)
        val stored = work?.stored
        changed()
        if (stored != null && !NotificationPlan.shouldNotify(stored.silent)) return
        if (foreground && focusedBotId == info.botId) {
            // The chat is open: the message appears there, no notification.
            notifier.cancel(store.markRead(info.botId))
            changed()
            return
        }
        // The app is open: it shows its own banner, and the notification goes
        // to the shade quietly (no sound or heads-up).
        val incoming = onIncoming.takeIf { foreground }
        if (incoming != null) main.post { incoming(info.botId, info.messageId) }
        val bot = store.bot(info.botId)
        val text = Banner.choose(stored, bot?.name, info, context.getString(R.string.new_notification))
        notifier.show(
            Notifier.Content(
                botId = info.botId,
                botName = text.botName,
                avatar = stored?.icon?.takeIf { it.isNotEmpty() } ?: bot?.avatar.orEmpty(),
                messageId = info.messageId,
                tag = tag,
                title = text.title,
                body = text.body,
                group = stored?.group ?: info.group,
                level = stored?.level?.takeIf { it.isNotEmpty() } ?: info.level,
                date = stored?.date?.takeIf { it > 0 } ?: System.currentTimeMillis(),
                muted = store.isMuted(info.botId) || incoming != null,
                url = stored?.url.orEmpty(),
                copy = stored?.copy.orEmpty(),
                open = stored?.open.orEmpty(),
                image = stored?.image.orEmpty(),
                imageBudgetMs = deadline.remainingMs().coerceIn(1_000, IMAGE_BUDGET_MS),
            ),
        )
    }

    private fun handleSilent(info: PushInfo) {
        if (!isRegistered) return
        val deadline = Deadline(PUSH_BUDGET_MS)
        val applied = try {
            TimeBox.run(deadline.remainingMs(), "honk-push") {
                renameBeforePush()
                fetchOpened(info.messageId)?.let {
                    notifier.cancel(store.apply(it).staleNotificationIds)
                }
                changed()
                true
            }
        } catch (e: Exception) {
            // Gone from the queue already (a sync applied it) or offline: sync instead, with the time left.
            if (!deadline.expired) TimeBox.run(deadline.remainingMs(), "honk-push") { refresh(); true }
            return
        }
        if (applied == null) Log.w(TAG, "push ${info.messageId} ran out of time")
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
        private const val KEY_REGISTER_KEY = "register-key"

        /** The whole handling of a push; FCM gives a high-priority message about 20 s. */
        const val PUSH_BUDGET_MS = 15_000L
        /** The most the picture and avatar downloads may take, at the end of [PUSH_BUDGET_MS]. */
        private const val IMAGE_BUDGET_MS = 6_000L
        /** Every request of a push gives up after this. */
        private const val FETCH_TIMEOUT_MS = 8_000
        /** The key refresh a push may trigger runs at most this often. */
        private const val KEY_REFRESH_INTERVAL_MS = 5 * 60 * 1000L
        @Volatile private var instance: HonkService? = null

        fun get(context: Context): HonkService =
            instance ?: synchronized(this) { instance ?: HonkService(context).also { instance = it } }
    }
}
