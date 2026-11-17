package dev.evumi.honk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.longbridge.nsh.NshView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Hosts the nsh app (built from ../app into assets/nsh) full screen and wires
 * the bridge. The counterpart of ios/App/RootViewController.swift and the
 * notification parts of AppDelegate.swift.
 */
class MainActivity : ComponentActivity() {
    private lateinit var nsh: NshView
    private lateinit var bridge: NshBridge
    private val service by lazy { HonkService.get(this) }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        bridge.statusChanged()
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        nsh = NshView(this)
        nsh.setErrorListener { Log.e("honk", "nsh: $it") }
        setContentView(nsh)

        bridge = NshBridge(this, nsh, service)
        bridge.install()
        nsh.setParams(mapOf("gatewayURL" to service.gatewayUrl, "platform" to "android"))
        load()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!nsh.handleBack()) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        requestNotificationPermission()
        handleOpen(intent)
    }

    private fun load() {
        // Debug builds: `adb shell am start -n dev.evumi.honk/.MainActivity --es nshDevUrl ws://127.0.0.1:8790/ws`
        // (with `adb reverse tcp:8790 tcp:8790`) connects to `nsh dev ../app/App.tsx` for hot reload.
        val dev = intent.getStringExtra(EXTRA_DEV_URL)
        if (BuildConfig.DEBUG && dev != null && nsh.connectDevServer(dev)) return
        assets.runCatching { open("nsh/capabilities.json").bufferedReader().use { it.readText() } }
            .getOrNull()
            ?.let { if (!nsh.setGrantedCapabilities(it)) Log.w("honk", "nsh: invalid capabilities.json") }
        if (!nsh.loadAssetBundle("nsh")) {
            Log.e("honk", "assets/nsh/bundle.nshc is missing: run scripts/build-nsh-bundle.sh")
        }
    }

    /** Android 13+: POST_NOTIFICATIONS is a runtime permission. Asked once; afterwards the app links to settings. */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = getSharedPreferences("honk", MODE_PRIVATE)
        if (prefs.getBoolean(KEY_ASKED, false)) return
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** Whether the permission dialog was shown already (for honk.status's notDetermined). */
    fun askedForNotifications(): Boolean = getSharedPreferences("honk", MODE_PRIVATE).getBoolean(KEY_ASKED, false)

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleOpen(intent)
    }

    /** A tapped notification: a message with a url opens it; otherwise its chat. */
    private fun handleOpen(intent: Intent?) {
        if (intent?.action != ACTION_OPEN) return
        val botId = intent.getLongExtra(EXTRA_BOT_ID, 0)
        val messageId = intent.getLongExtra(EXTRA_MESSAGE_ID, 0)
        intent.action = null // not again after a configuration change
        if (botId == 0L) return
        lifecycleScope.launch(Dispatchers.IO) {
            val url = if (messageId > 0) service.store.message(messageId)?.url.orEmpty() else ""
            launch(Dispatchers.Main) {
                if (url.startsWith("https://") || url.startsWith("http://")) {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                } else {
                    // Kept by nsh until the app listens, so this works before it has loaded.
                    bridge.openChat(botId)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        service.foreground = true
        bridge.statusChanged()
        lifecycleScope.launch(Dispatchers.IO) { service.refresh() }
    }

    override fun onPause() {
        service.foreground = false
        super.onPause()
    }

    override fun onDestroy() {
        bridge.uninstall()
        nsh.destroy()
        super.onDestroy()
    }

    companion object {
        const val ACTION_OPEN = "dev.evumi.honk.OPEN_CHAT"
        const val EXTRA_BOT_ID = "botId"
        const val EXTRA_MESSAGE_ID = "messageId"
        const val EXTRA_DEV_URL = "nshDevUrl"
        private const val KEY_ASKED = "notificationsAsked"
    }
}
