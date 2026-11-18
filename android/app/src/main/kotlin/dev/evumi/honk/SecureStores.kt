package dev.evumi.honk

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import dev.evumi.honk.core.ApiClient
import dev.evumi.honk.core.BotKeyStore
import dev.evumi.honk.core.BotTokenStore
import dev.evumi.honk.core.CredentialStore
import dev.evumi.honk.core.Credentials
import dev.evumi.honk.core.Seal

/** EncryptedSharedPreferences with a key in the Android Keystore. Not backed up (allowBackup is off). */
object SecurePrefs {
    fun open(context: Context, name: String = "honk.secure"): SharedPreferences =
        EncryptedSharedPreferences.create(
            name,
            MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
}

/** The device's id, secret and last push token. */
class PrefsCredentialStore(private val prefs: SharedPreferences) : CredentialStore {
    override fun load(): Credentials? = prefs.getString(KEY, null)?.let {
        runCatching { ApiClient.JSON.decodeFromString(Credentials.serializer(), it) }.getOrNull()
    }

    override fun save(c: Credentials) {
        prefs.edit().putString(KEY, ApiClient.JSON.encodeToString(Credentials.serializer(), c)).commit()
    }

    override fun clear() {
        prefs.edit().remove(KEY).commit()
    }

    private companion object {
        const val KEY = "credentials"
    }
}

/** Each bot's token, keyed `bot-token.<id>`. */
class PrefsBotTokenStore(private val prefs: SharedPreferences) : BotTokenStore {
    override fun token(botId: String): String? = prefs.getString(key(botId), null)

    override fun save(botId: String, token: String) {
        prefs.edit().putString(key(botId), token).apply()
    }

    override fun remove(botId: String) {
        prefs.edit().remove(key(botId)).apply()
    }

    override fun removeAll() {
        val edit = prefs.edit()
        prefs.all.keys.filter { it.startsWith(PREFIX) }.forEach(edit::remove)
        edit.apply()
    }

    private fun key(botId: String) = "$PREFIX$botId"

    private companion object {
        const val PREFIX = "bot-token."
    }
}

/**
 * Each bot's end-to-end key, keyed `bot-key.<id>` as unpadded base64url, in the
 * same EncryptedSharedPreferences as the tokens (Keystore-backed, not backed up).
 * The FCM service and the activity share them, so a notification can be
 * decrypted while the app is closed.
 */
class PrefsBotKeyStore(private val prefs: SharedPreferences) : BotKeyStore {
    override fun key(botId: String): ByteArray? = prefs.getString(key(botId), null)?.let(Seal::parseKey)

    override fun save(botId: String, key: ByteArray) {
        prefs.edit().putString(key(botId), Seal.encode(key)).commit()
    }

    override fun remove(botId: String) {
        prefs.edit().remove(key(botId)).commit()
    }

    override fun removeAll() {
        val edit = prefs.edit()
        prefs.all.keys.filter { it.startsWith(PREFIX) }.forEach(edit::remove)
        edit.commit()
    }

    private fun key(botId: String) = "$PREFIX$botId"

    private companion object {
        const val PREFIX = "bot-key."
    }
}
