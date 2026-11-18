package dev.evumi.honk.core

/**
 * The plain text of a `parse_mode=Markdown` body: the banner of a message
 * whose push carried no text. The same rules as the gateway's `StripMarkdown`
 * (gateway/internal/api/markdown.go) and `MarkdownText.swift`: keep the three in step.
 */
object MarkdownText {
    private val code = Regex("`[^`\n]+`")
    private val link = Regex("""\[([^\]\n]+)\]\(([^)\s]+)\)""")
    private val bold = Regex("""\*\*(.+?)\*\*|__(.+?)__""")
    private val italic = Regex("""\*([^*\s][^*]*?)\*|(^|[^\p{L}\p{N}_])_([^_\s][^_]*?)_($|[^\p{L}\p{N}_])""")
    private val list = Regex("""^(\s*)[-*+]\s+""")
    private val head = Regex("""^#{1,6}\s+""")

    fun strip(s: String): String {
        val out = mutableListOf<String>()
        var fenced = false
        for (line in s.replace("\r\n", "\n").split("\n")) {
            if (line.trim().startsWith("```")) {
                fenced = !fenced
                continue
            }
            if (fenced) {
                out += line
                continue
            }
            var l = head.replace(line, "")
            l = list.replace(l, "$1• ")
            out += inline(l)
        }
        return out.joinToString("\n").trim()
    }

    private fun inline(l: String): String {
        val b = StringBuilder()
        var last = 0
        for (m in code.findAll(l)) {
            b.append(marks(l.substring(last, m.range.first)))
            b.append(l.substring(m.range.first + 1, m.range.last))
            last = m.range.last + 1
        }
        b.append(marks(l.substring(last)))
        return b.toString()
    }

    private fun marks(text: String): String {
        var s = link.replace(text, "$1")
        s = bold.replace(s, "$1$2")
        // Twice: a match consumes its neighbours, so "_a_ _b_" needs a second pass.
        repeat(2) { s = italic.replace(s, "$1$2$3$4") }
        return s
    }
}
