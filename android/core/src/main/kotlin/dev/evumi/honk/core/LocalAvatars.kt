package dev.evumi.honk.core

import java.io.File
import java.io.IOException
import java.util.Base64
import java.util.UUID

/**
 * Images the user picked as bot avatars, kept on this phone only. The bot's
 * avatar names the file (`local:<name>`); the gateway stores only that string.
 * The same rules as ios/HonkKit's `LocalAvatars`.
 */
class LocalAvatars(private val dir: File) {
    class SaveException(message: String) : IOException(message)

    /** Keeps a JPEG or PNG and returns the avatar that names it, `local:<name>`. */
    fun save(data: ByteArray): String {
        if (data.size > MAX_BYTES) throw SaveException("图片太大，请换一张小一点的")
        val ext = when {
            data.startsWith(0xFF, 0xD8, 0xFF) -> "jpg"
            data.startsWith(0x89, 0x50, 0x4E, 0x47) -> "png"
            else -> throw SaveException("只支持 JPEG 和 PNG 图片")
        }
        dir.mkdirs()
        val name = UUID.randomUUID().toString() + "." + ext
        val tmp = File(dir, "$name.tmp")
        tmp.writeBytes(data)
        if (!tmp.renameTo(File(dir, name))) throw IOException("could not save $name")
        return "local:$name"
    }

    /** The file of a `local:` avatar, null for any other avatar or when it is not on this phone. */
    fun file(avatar: String): File? {
        val a = Avatar.parse(avatar) as? Avatar.Local ?: return null
        return File(dir, a.name).takeIf { it.isFile }
    }

    fun data(avatar: String): ByteArray? = file(avatar)?.readBytes()

    /** The image as a `data:` URL, for the nsh app to show. */
    fun dataUrl(avatar: String): String? {
        val d = data(avatar) ?: return null
        val type = if (avatar.endsWith(".png")) "image/png" else "image/jpeg"
        return "data:$type;base64," + Base64.getEncoder().encodeToString(d)
    }

    /**
     * Deletes images no bot uses any more. Ones younger than [graceMs] stay: a
     * picked image is saved before the bot that will use it is created.
     */
    fun prune(keeping: Set<String>, graceMs: Long = 3_600_000, now: Long = System.currentTimeMillis()) {
        dir.listFiles()?.forEach { f ->
            if ("local:${f.name}" !in keeping && now - f.lastModified() > graceMs) f.delete()
        }
    }

    companion object {
        /** The most a picked image may weigh (the app scales it to 512 px first). */
        const val MAX_BYTES = 512 * 1024

        fun isValidName(name: String): Boolean {
            val parts = name.split(".")
            return parts.size == 2 && (parts[1] == "jpg" || parts[1] == "png") && parts[0].isNotEmpty() &&
                parts[0].all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }
        }

        private fun ByteArray.startsWith(vararg bytes: Int) =
            size >= bytes.size && bytes.indices.all { this[it] == bytes[it].toByte() }
    }
}
