package dev.evumi.honk

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dev.evumi.honk.core.Avatar
import dev.evumi.honk.core.Banner
import dev.evumi.honk.core.Bot
import dev.evumi.honk.core.LocalAvatars
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Builds the system notifications: one NotificationChannel per bot (in a
 * "Bots" group, so the user can tune each bot in system settings), a
 * MessagingStyle notification whose sender is the bot with its avatar, and a
 * conversation shortcut per bot so Android 11+ shows it as a conversation.
 *
 * Notifications are identified by a tag: the bot and collapse id when the
 * message has one (a newer message with the same id replaces the
 * notification in place), else the message id. The tag is what LocalStore
 * keeps as the message's notification id.
 */
class Notifier(private val context: Context) {
    data class Content(
        val botId: String,
        val botName: String,
        val avatar: String,
        val messageId: Long,
        val tag: String,
        val title: String,
        val body: String,
        val group: String,
        val level: String,
        val date: Long,
        val muted: Boolean,
    )

    private val manager = NotificationManagerCompat.from(context)

    fun canPost(): Boolean =
        manager.areNotificationsEnabled() && (
            Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            )

    // channels

    private fun ensureGroup() {
        manager.createNotificationChannelGroup(NotificationChannelGroup(GROUP, context.getString(R.string.channel_group_bots)))
    }

    /** Creates or renames the bot's channel. Importance is only set at creation; afterwards it is the user's. */
    fun ensureChannel(botId: String, name: String) {
        ensureGroup()
        val ch = NotificationChannel(channelId(botId), name.ifEmpty { context.getString(R.string.channel_other) }, NotificationManager.IMPORTANCE_HIGH)
        ch.group = GROUP
        ch.setShowBadge(true)
        manager.createNotificationChannel(ch)
    }

    /** Matches the channels to the bot list: creates and renames, deletes the channels of bots that are gone. */
    fun syncChannels(bots: List<Bot>) {
        bots.forEach { ensureChannel(it.id, it.name) }
        val keep = bots.map { channelId(it.id) }.toSet()
        manager.notificationChannels
            .filter { it.id.startsWith(CHANNEL_PREFIX) && it.id !in keep }
            .forEach { manager.deleteNotificationChannel(it.id) }
        ShortcutManagerCompat.removeLongLivedShortcuts(
            context,
            ShortcutManagerCompat.getDynamicShortcuts(context).map { it.id }.filter { it.startsWith(CHANNEL_PREFIX) && it !in keep },
        )
    }

    /**
     * A bot known by a legacy integer id got its short id: create `bot-<new>`
     * with the settings the user gave `bot-<old>` (importance, sound,
     * vibration, lights, lock screen, badge), then delete the old channel.
     */
    fun moveChannel(old: String, new: String) {
        val from = manager.getNotificationChannel(channelId(old)) ?: return
        if (manager.getNotificationChannel(channelId(new)) == null) {
            ensureGroup()
            val ch = NotificationChannel(channelId(new), from.name, from.importance)
            ch.group = GROUP
            ch.description = from.description
            ch.setSound(from.sound, from.audioAttributes)
            ch.enableVibration(from.shouldVibrate())
            ch.vibrationPattern = from.vibrationPattern
            ch.enableLights(from.shouldShowLights())
            ch.lightColor = from.lightColor
            ch.lockscreenVisibility = from.lockscreenVisibility
            ch.setShowBadge(from.canShowBadge())
            manager.createNotificationChannel(ch)
        }
        deleteChannel(old)
    }

    fun deleteChannel(botId: String) {
        manager.deleteNotificationChannel(channelId(botId))
        ShortcutManagerCompat.removeLongLivedShortcuts(context, listOf(channelId(botId)))
    }

    // posting

    fun show(c: Content) {
        if (!canPost()) return
        ensureChannel(c.botId, c.botName)
        val icon = avatarBitmap(Avatar.parse(c.avatar), c.botName)?.let(IconCompat::createWithBitmap)
        val bot = Person.Builder()
            .setName(c.botName)
            .setKey(channelId(c.botId))
            .setBot(true)
            .setIcon(icon)
            .build()
        val me = Person.Builder().setName(context.getString(R.string.me)).build()
        val text = SpannableStringBuilder().apply {
            if (c.title.isNotEmpty()) {
                append(c.title, StyleSpan(Typeface.BOLD), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                if (c.body.isNotEmpty()) append('\n')
            }
            append(c.body)
        }
        val style = NotificationCompat.MessagingStyle(me)
            .addMessage(NotificationCompat.MessagingStyle.Message(text, c.date, bot))
        pushShortcut(c.botId, c.botName, bot, icon)

        // passive and muted bots: no sound or heads-up, like iOS's passive level.
        val quiet = c.muted || c.level == "passive"
        val n = NotificationCompat.Builder(context, channelId(c.botId))
            .setSmallIcon(R.drawable.ic_notification)
            .setStyle(style)
            .setContentTitle(c.botName)
            .setContentText(text)
            .setWhen(c.date)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setShortcutId(channelId(c.botId))
            .setLocusId(androidx.core.content.LocusIdCompat(channelId(c.botId)))
            .setGroup(if (c.group.isEmpty()) channelId(c.botId) else "${channelId(c.botId)}:${c.group}")
            .setSilent(quiet)
            .setPriority(if (quiet) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openIntent(c.botId, c.messageId))
            .build()
        try {
            manager.notify(c.tag, NOTIFICATION_ID, n)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS was revoked between canPost and notify.
        }
    }

    fun cancel(tags: List<String>) {
        tags.forEach { manager.cancel(it, NOTIFICATION_ID) }
    }

    /** Removes every notification of the app. */
    fun cancelAll() {
        manager.cancelAll()
    }

    private fun openIntent(botId: String, messageId: Long): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_BOT_ID, botId)
            .putExtra(MainActivity.EXTRA_MESSAGE_ID, messageId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(
            context,
            messageId.toInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun pushShortcut(botId: String, name: String, person: Person, icon: IconCompat?) {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_BOT_ID, botId)
        val shortcut = ShortcutInfoCompat.Builder(context, channelId(botId))
            .setShortLabel(name.ifEmpty { "Honk" })
            .setLongLived(true)
            .setPerson(person)
            .setIntent(intent)
            .setLocusId(androidx.core.content.LocusIdCompat(channelId(botId)))
            .apply { if (icon != null) setIcon(icon) }
            .build()
        runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, shortcut) }
    }

    // avatars

    /**
     * The avatar as a bitmap: an https image (cached, 5 s timeout, 2 MB at
     * most) or a picked image kept on the phone, else the preset's colour with the bot name's first letter. The
     * preset icon itself is drawn by the nsh app; the notification uses the
     * letter so the app ships no icon set of its own.
     */
    fun avatarBitmap(avatar: Avatar, name: String, size: Int = 192): Bitmap? {
        if (avatar is Avatar.Image) {
            image(avatar.url)?.let { return circle(it, size) }
        }
        if (avatar is Avatar.Local) {
            localAvatars(context).file(avatar.stringValue)?.let { BitmapFactory.decodeFile(it.path) }?.let { return circle(it, size) }
        }
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = avatar.argb }
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        val letter = name.trim().let { if (it.isEmpty()) "H" else it.substring(0, it.offsetByCodePoints(0, 1)).uppercase() }
        paint.color = Color.WHITE
        paint.textSize = size * 0.46f
        paint.typeface = Typeface.DEFAULT_BOLD
        paint.textAlign = Paint.Align.CENTER
        val y = size / 2f - (paint.descent() + paint.ascent()) / 2
        canvas.drawText(letter, size / 2f, y, paint)
        return bmp
    }

    private fun image(url: String): Bitmap? {
        val dir = File(context.cacheDir, "avatars").apply { mkdirs() }
        val name = MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }
        val file = File(dir, name)
        if (!file.exists()) {
            val bytes = runCatching {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                try {
                    if (conn.responseCode != 200 || conn.contentLengthLong > MAX_IMAGE) return null
                    conn.inputStream.use { it.readNBytesCompat(MAX_IMAGE + 1) }
                } finally {
                    conn.disconnect()
                }
            }.getOrNull() ?: return null
            if (bytes.size > MAX_IMAGE) return null
            file.writeBytes(bytes)
        }
        return BitmapFactory.decodeFile(file.path)
    }

    private fun circle(src: Bitmap, size: Int): Bitmap {
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
        val side = minOf(src.width, src.height)
        val from = android.graphics.Rect((src.width - side) / 2, (src.height - side) / 2, (src.width + side) / 2, (src.height + side) / 2)
        canvas.drawBitmap(src, from, android.graphics.Rect(0, 0, size, size), paint)
        return out
    }

    companion object {
        const val GROUP = "bots"
        const val CHANNEL_PREFIX = "bot-"
        const val NOTIFICATION_ID = 1
        private const val MAX_IMAGE = 2 shl 20

        /** Where picked avatar images are kept (not backed up, like the database). */
        fun localAvatars(context: Context) = LocalAvatars(File(context.noBackupFilesDir, "avatars"))

        fun channelId(botId: String) = "$CHANNEL_PREFIX$botId"

        /** The notification tag: `c<bot>:<collapse id>` when the message has one, else `m<message id>`. */
        fun tag(botId: String, messageId: Long, collapseId: String) = Banner.tag(botId, messageId, collapseId)
    }
}

/** InputStream.readNBytes is API 33; read at most [max] bytes. */
private fun java.io.InputStream.readNBytesCompat(max: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (out.size() < max) {
        val n = read(buf, 0, minOf(buf.size, max - out.size()))
        if (n < 0) break
        out.write(buf, 0, n)
    }
    return out.toByteArray()
}
