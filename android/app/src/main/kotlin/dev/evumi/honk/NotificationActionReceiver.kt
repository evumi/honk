package dev.evumi.honk

import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import dev.evumi.honk.core.NotificationPlan

/**
 * The "Copy" and "Mark as read" buttons of a notification. ("Open link" is an
 * ACTION_VIEW activity intent on the notification itself: Android 12+ does not
 * let a receiver start activities.) The counterpart of the action handling in
 * ios/App/AppDelegate.swift.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = NotificationPlan.Action.of(intent.action) ?: return
        val botId = intent.getStringExtra(EXTRA_BOT_ID) ?: return
        val messageId = intent.getLongExtra(EXTRA_MESSAGE_ID, 0)
        val tag = intent.getStringExtra(EXTRA_TAG)
        val pending = goAsync()
        // The database is touched off the main thread.
        Thread {
            try {
                val service = HonkService.get(context)
                when (action) {
                    NotificationPlan.Action.COPY -> {
                        val text = service.store.message(messageId)?.copy.orEmpty()
                        if (text.isNotEmpty()) {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.setPrimaryClip(ClipData.newPlainText("honk", text))
                        }
                    }
                    NotificationPlan.Action.MARK_READ -> {
                        service.markRead(botId)
                        if (tag != null) service.notifier.cancel(listOf(tag))
                    }
                    NotificationPlan.Action.OPEN_URL -> Unit // the notification's own activity intent opens it
                }
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        const val EXTRA_BOT_ID = "bot_id"
        const val EXTRA_MESSAGE_ID = "message_id"
        const val EXTRA_TAG = "tag"
    }
}
