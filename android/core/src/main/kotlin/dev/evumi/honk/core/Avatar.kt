package dev.evumi.honk.core

/**
 * A bot avatar: a preset icon on a coloured circle, or an image URL.
 *
 * Stored as a string in the bot's `avatar` field: `preset:<icon>:<#rrggbb>`
 * (icon names are the app's own set, the same as ios/HonkKit's Avatar) or an
 * `https://` URL. Anything else falls back to [DEFAULT].
 */
sealed class Avatar {
    data class Preset(val icon: String, val color: String) : Avatar()
    data class Image(val url: String) : Avatar()

    val stringValue: String
        get() = when (this) {
            is Preset -> "preset:$icon:$color"
            is Image -> url
        }

    /** The colour as 0xAARRGGBB; the default blue for an image. */
    val argb: Int
        get() {
            val hex = (this as? Preset)?.color ?: (DEFAULT as Preset).color
            return (0xFF000000 or hex.drop(1).toLong(16)).toInt()
        }

    companion object {
        val DEFAULT: Avatar = Preset("bell", "#0a6ed1")

        /** The preset icon names (the nsh app offers the same set). */
        val ICONS = setOf("bell", "ship", "alert", "check", "wallet", "server", "chart", "box", "cloud", "code")

        fun parse(s: String?): Avatar {
            if (s == null) return DEFAULT
            if (s.startsWith("https://") && s.length > "https://".length) return Image(s)
            val parts = s.split(":")
            if (parts.size == 3 && parts[0] == "preset" && parts[1] in ICONS && isHex(parts[2])) {
                return Preset(parts[1], parts[2])
            }
            return DEFAULT
        }

        private fun isHex(s: String) =
            s.length == 7 && s[0] == '#' && s.drop(1).all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
    }
}
