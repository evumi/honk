package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ConnectException

// The same cases as GatewayConfigTests in ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class GatewayConfigTest {
    @Test fun normalize() {
        assertEquals("https://honk.example.com/", Gateway.normalize("honk.example.com"))
        assertEquals("http://10.0.0.2:8080/", Gateway.normalize(" HTTP://10.0.0.2:8080 "))
        assertEquals("https://e.com/honk/", Gateway.normalize("https://e.com/honk"))
        assertEquals("https://e.com/honk/", Gateway.normalize("https://e.com/honk/"))
        assertEquals("http://10.0.2.2:8080/", Gateway.normalize("http://10.0.2.2:8080/"))
        assertNull(Gateway.normalize("ftp://e.com"))
        assertNull(Gateway.normalize("https://e.com/?a=1"))
        assertNull(Gateway.normalize("https://e.com/#x"))
        assertNull(Gateway.normalize("https://"))
        assertNull(Gateway.normalize("https://e .com"))
        assertNull(Gateway.normalize(""))
        assertNull(Gateway.normalize("   "))
    }

    @Test fun checkAcceptsAHonkGateway() {
        val gw = FakeGateway { method, path, _ ->
            if (method == "GET" && path == "v1/info") FakeGateway.ok("""{"name":"honk","version":"0.2.0","api":1}""")
            else FakeGateway.fail(404, "Not Found")
        }
        assertEquals(Gateway.Checked(FakeGateway.BASE, "0.2.0"), Gateway.check("http://gw.test", gw))
        assertNull("no device secret is sent", gw.requests.single().headers["Authorization"])
    }

    @Test fun checkRejectsOtherServers() {
        val other = FakeGateway { _, _, _ -> FakeGateway.ok("""{"name":"bark","version":"1"}""") }
        assertThrows(Gateway.NotHonk::class.java) { Gateway.check("http://gw.test", other) }
        val html = FakeGateway { _, _, _ -> 200 to "<html></html>" }
        assertThrows(ApiException.BadResponse::class.java) { Gateway.check("http://gw.test", html) }
        assertThrows(Gateway.InvalidUrl::class.java) { Gateway.check("ftp://gw.test", html) }
        assertTrue("an invalid address sends nothing", html.requests.size == 1)
    }

    @Test fun describe() {
        assertEquals("这个地址不是 Honk 网关", Gateway.describe(Gateway.NotHonk()))
        assertEquals("401 Unauthorized", Gateway.describe(ApiException.Gateway(401, "Unauthorized")))
        assertEquals("连不上网关（refused）", Gateway.describe(ConnectException("refused")))
    }

    @Test fun resetForgetsEverything() {
        val store = tempStore()
        store.apply(QueuedMessage(1, "b1", body = "x"), "n1")
        store.syncCursor = 9
        assertEquals(listOf("n1"), store.reset())
        assertTrue(store.chats().isEmpty())
        assertEquals(0L, store.syncCursor)
    }
}
