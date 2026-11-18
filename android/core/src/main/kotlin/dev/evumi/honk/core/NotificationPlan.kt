package dev.evumi.honk.core

import java.net.URI

/**
 * What a notification offers and what tapping it does, decided from the
 * message alone so the Android app stays thin. Mirrors
 * ios/HonkKit/Sources/HonkKit/NotificationPlan.swift.
 */
object NotificationPlan {
    /** The notification's buttons. */
    enum class Action(val id: String) {
        COPY("dev.evumi.honk.action.COPY"),
        OPEN_URL("dev.evumi.honk.action.OPEN_URL"),
        MARK_READ("dev.evumi.honk.action.MARK_READ");

        companion object {
            fun of(id: String?): Action? = values().firstOrNull { it.id == id }
        }
    }

    /** "Copy" when the message has a copy text, "Open link" when it has a url, "Mark as read" always. */
    fun actions(copy: String, url: String): List<Action> = buildList {
        if (copy.isNotEmpty()) add(Action.COPY)
        if (openableUrl(url) != null) add(Action.OPEN_URL)
        add(Action.MARK_READ)
    }

    fun actions(m: StoredMessage): List<Action> = actions(m.copy, m.url)

    /** What a tap on the notification body does. */
    sealed class Tap {
        data class Chat(val botId: String) : Tap()
        data class Url(val url: String) : Tap()
    }

    /** `open=url` with a usable url opens it; everything else opens the chat. */
    fun tap(open: String, url: String, botId: String): Tap =
        if (open == "url" && openableUrl(url) != null) Tap.Url(url) else Tap.Chat(botId)

    /** Only http(s) links are opened from a notification. */
    fun openableUrl(s: String): String? {
        if (s.isEmpty()) return null
        val u = runCatching { URI(s) }.getOrNull() ?: return null
        val scheme = u.scheme?.lowercase()
        return if ((scheme == "https" || scheme == "http") && !u.host.isNullOrEmpty()) s else null
    }

    /** The image to attach: https only (the device downloads it). */
    fun imageUrl(s: String): String? {
        if (s.isEmpty()) return null
        val u = runCatching { URI(s) }.getOrNull() ?: return null
        return if (u.scheme?.lowercase() == "https" && !u.host.isNullOrEmpty()) s else null
    }

    /** A message gets a notification unless it is silent: stored and counted only. */
    fun shouldNotify(silent: Boolean): Boolean = !silent

    /** The most an attached image may be, and how long the download may take. */
    const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
    const val IMAGE_TIMEOUT_MS = 10_000
}
