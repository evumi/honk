package dev.evumi.honk.core

import java.io.IOException
import java.net.URI

/** Gateway addresses: normalising what the user types, and checking that it is a Honk gateway. */
object Gateway {
    /**
     * An http(s) URL with a host, ending in `/` so API paths resolve under it;
     * a bare host gets `https://`. Null for anything else, a query or fragment
     * included. The same rules as HonkConfig.normalizeGateway on iOS.
     */
    fun normalize(s: String): String? {
        var t = s.trim()
        if (t.isEmpty()) return null
        if (!t.contains("://")) t = "https://$t"
        val uri = try {
            URI(t)
        } catch (e: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https" && scheme != "http") return null
        if (uri.host.isNullOrEmpty() || uri.rawQuery != null || uri.rawFragment != null) return null
        var path = uri.rawPath.orEmpty()
        if (!path.endsWith("/")) path += "/"
        return "$scheme://${uri.rawAuthority}$path"
    }

    /** A successful check: the normalised address and the gateway's version. */
    data class Checked(val url: String, val version: String)

    class InvalidUrl : IOException("地址无效：需要 http:// 或 https:// 开头的网址")
    class NotHonk : IOException("这个地址不是 Honk 网关")

    /** Checks that [address] answers `GET /v1/info` with name "honk". Blocking. */
    fun check(address: String, transport: Transport = HttpTransport()): Checked {
        val url = normalize(address) ?: throw InvalidUrl()
        val info = ApiClient(url, null, transport).info()
        if (info.name != "honk") throw NotHonk()
        return Checked(url, info.version)
    }

    /** A short Chinese description of a failure, for the settings page. */
    fun describe(e: Throwable): String = when (e) {
        is ApiException, is InvalidUrl, is NotHonk -> e.message.orEmpty()
        is IOException -> "连不上网关（${e.message ?: e.javaClass.simpleName}）"
        else -> e.message ?: e.javaClass.simpleName
    }
}
