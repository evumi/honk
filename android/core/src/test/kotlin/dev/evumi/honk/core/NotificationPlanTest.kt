package dev.evumi.honk.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import dev.evumi.honk.core.NotificationPlan.Action

// The same cases as NotificationPlanTests in ios/HonkKit/Tests/HonkKitTests/HonkKitTests.swift.
class NotificationPlanTest {
    @Test fun actionsFollowTheMessage() {
        assertEquals(listOf(Action.MARK_READ), NotificationPlan.actions("", ""))
        assertEquals(listOf(Action.COPY, Action.MARK_READ), NotificationPlan.actions("c", ""))
        assertEquals(listOf(Action.OPEN_URL, Action.MARK_READ), NotificationPlan.actions("", "https://a.example"))
        assertEquals(listOf(Action.COPY, Action.OPEN_URL, Action.MARK_READ), NotificationPlan.actions("c", "http://a.example"))
        assertEquals("only http(s) links get a button", listOf(Action.MARK_READ), NotificationPlan.actions("", "javascript:alert(1)"))
    }

    @Test fun tapOpensTheChatUnlessOpenIsUrl() {
        assertEquals(NotificationPlan.Tap.Chat("b"), NotificationPlan.tap("", "https://a.example", "b"))
        assertEquals(NotificationPlan.Tap.Url("https://a.example"), NotificationPlan.tap("url", "https://a.example", "b"))
        assertEquals("no url: the chat", NotificationPlan.Tap.Chat("b"), NotificationPlan.tap("url", "", "b"))
        assertEquals(NotificationPlan.Tap.Chat("b"), NotificationPlan.tap("url", "ftp://a.example", "b"))
    }

    @Test fun silentMessagesDoNotNotify() {
        assertTrue(NotificationPlan.shouldNotify(false))
        assertFalse(NotificationPlan.shouldNotify(true))
    }

    @Test fun imageRules() {
        assertEquals("https://a.example/i.png", NotificationPlan.imageUrl("https://a.example/i.png"))
        assertNull(NotificationPlan.imageUrl("http://a.example/i.png"))
        assertNull(NotificationPlan.imageUrl(""))
        assertNull(NotificationPlan.imageUrl("not a url"))
        assertEquals(5 * 1024 * 1024, NotificationPlan.MAX_IMAGE_BYTES)
    }

    @Test fun actionIdsRoundTrip() {
        Action.values().forEach { assertEquals(it, Action.of(it.id)) }
        assertNull(Action.of("other"))
    }

    @Test fun pushInfoReadsSilent() {
        val quiet = PushInfo.parse(mapOf("kind" to "message", "msg_id" to "7", "bot_id" to "b", "silent" to "1"))!!
        assertTrue(quiet.silent)
        assertFalse(PushInfo.parse(mapOf("kind" to "message", "msg_id" to "7", "bot_id" to "b"))!!.silent)
    }

    @Test fun markdownTextStripsTheMarks() {
        val cases = mapOf(
            "**粗** *斜* __粗__ _斜_" to "粗 斜 粗 斜",
            "`a*b*c` 和 **x**" to "a*b*c 和 x",
            "见 [文档](https://a.example/d)" to "见 文档",
            "# 标题\n- 一\n* 二\n1. 三" to "标题\n• 一\n• 二\n1. 三",
            "```\nx := a * b * c\n```\n结束" to "x := a * b * c\n结束",
            "snake_case_name 2 * 3 * 4" to "snake_case_name 2 * 3 * 4",
            "_a_ _b_" to "a b",
        )
        for ((input, want) in cases) assertEquals(input, want, MarkdownText.strip(input))
    }

    @Test fun markdownBannerOfAMessageWithoutPushText() {
        val stored = StoredMessage(1, "b", "", "**128 个测试通过**", "", "", "", "", "", "", "", "", "", "Markdown", false, "", 1, false)
        val t = Banner.choose(stored, "CI", PushInfo(QueuedMessage.Kind.MESSAGE, 1, "b"), "新通知")
        assertEquals("128 个测试通过", t.body)
    }
}
