package dev.evumi.honk

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.evumi.honk.core.PushInfo

/**
 * Receives the gateway's FCM data messages (fields in
 * gateway/internal/push/fcm.go). Firebase calls both methods on a background
 * thread, so they may block on the network; a HIGH priority message has
 * about 20 seconds.
 */
class HonkMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        HonkService.get(this).register(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val info = PushInfo.parse(message.data)
        if (info == null) {
            Log.w("honk", "ignoring an FCM message without kind/msg_id/bot_id")
            return
        }
        HonkService.get(this).handlePush(info)
    }

    override fun onDeletedMessages() {
        // FCM dropped pending messages (the device was offline too long): sync.
        HonkService.get(this).refresh()
    }
}
