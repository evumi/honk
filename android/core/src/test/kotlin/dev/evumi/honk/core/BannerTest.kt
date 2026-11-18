package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Test

// The same cases as BannerTextTests in ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class BannerTest {
    private fun message(title: String = "", body: String = "") =
        StoredMessage(1, "b", title, body, "", "", "", "", "", "", "", "", 1, false)

    private fun push(botName: String = "", title: String = "", body: String = "", collapseId: String = "") =
        PushInfo(QueuedMessage.Kind.MESSAGE, 1, "b", botName = botName, title = title, body = body, collapseId = collapseId)

    @Test fun contentlessPushTakesEverythingFromTheMessage() {
        val t = Banner.choose(message("部署成功", "sluice 已上线"), "部署", push(), "新通知")
        assertEquals(BannerText("部署", "部署成功", "sluice 已上线"), t)
    }

    @Test fun fetchFailureOnContentlessPushShowsTheGenericText() {
        assertEquals(BannerText("Honk", "", "新通知"), Banner.choose(null, null, push(), "新通知"))
        assertEquals(BannerText("部署", "", "新通知"), Banner.choose(null, "部署", push(), "新通知"))
    }

    @Test fun pushWithContentSurvivesAFailedFetch() {
        val t = Banner.choose(null, null, push("部署", "成功", "已上线"), "新通知")
        assertEquals(BannerText("部署", "成功", "已上线"), t)
    }

    @Test fun fetchedMessageWinsOverThePush() {
        val t = Banner.choose(message("新标题", "完整正文"), "本地名", push("旧名", "旧标题", "截断…"), "新通知")
        assertEquals(BannerText("本地名", "新标题", "完整正文"), t)
        // A message without a title keeps the push's; without a body, the push's body.
        assertEquals(BannerText("旧名", "旧标题", "旧正文"), Banner.choose(message(), null, push("旧名", "旧标题", "旧正文"), "新通知"))
        assertEquals(BannerText("Honk", "", "新通知"), Banner.choose(message(), "", push(), "新通知"))
    }

    @Test fun tagComesFromTheCollapseIdOrTheMessageId() {
        assertEquals("cbot:dep-1", Banner.tag("bot", 7, "dep-1"))
        assertEquals("m7", Banner.tag("bot", 7, ""))
    }
}
