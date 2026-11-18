package dev.evumi.honk.core

/** Keeps the device's [Credentials]. EncryptedSharedPreferences in the app. */
interface CredentialStore {
    fun load(): Credentials?
    fun save(c: Credentials)
    fun clear()
}

/** Keeps each bot's token: the gateway shows it only when it is created or reset. */
interface BotTokenStore {
    fun token(botId: String): String?
    fun save(botId: String, token: String)
    fun remove(botId: String)

    /** The ids of the bots that have a token here; used to drop the tokens of bots the gateway no longer lists. */
    fun ids(): List<String> = emptyList()

    /** Removes every bot's token (the device moved to another gateway). */
    fun removeAll()
}

/** Registers the device with the gateway or sends it a new push token. */
class DeviceRegistrar(
    private val gatewayUrl: String,
    private val credentials: CredentialStore,
    private val transport: Transport = HttpTransport(),
    /** Sent as `register_key` when registering, for a gateway that asks for one. */
    private val registerKey: String? = null,
    /** The phone's name or model, which the device group's list shows. */
    private val deviceName: String? = null,
    /** Called when the gateway no longer knows the device (401): the app drops the group key with the credentials. */
    private val onForgotten: () -> Unit = {},
) {
    enum class Result { UNCHANGED, UPDATED, REGISTERED }

    /**
     * Sends [pushToken] if it changed. When the gateway answers 401 (it forgot
     * this device), registers again; a new registration starts with no bots.
     */
    fun register(pushToken: String): Result {
        credentials.load()?.let { c ->
            if (c.pushToken == pushToken) return Result.UNCHANGED
            try {
                ApiClient(gatewayUrl, c.secret, transport).updatePushToken(pushToken)
                credentials.save(c.copy(pushToken = pushToken))
                return Result.UPDATED
            } catch (e: ApiException) {
                if (!e.isUnauthorized) throw e
                credentials.clear()
                onForgotten()
            }
        }
        val reg = ApiClient(gatewayUrl, null, transport).registerDevice(pushToken, registerKey = registerKey, name = deviceName)
        credentials.save(Credentials(reg.device.id, reg.deviceSecret, pushToken))
        return Result.REGISTERED
    }
}
