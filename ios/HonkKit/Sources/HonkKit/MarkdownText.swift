import Foundation

/// The plain text of a `parse_mode=Markdown` body: the banner of a message
/// whose push carried no text. The same rules as the gateway's `StripMarkdown`
/// (gateway/internal/api/markdown.go) and `MarkdownText.kt`: keep the three in step.
public enum MarkdownText {
    private static func re(_ p: String) -> NSRegularExpression { try! NSRegularExpression(pattern: p) }

    private static let code = re("`[^`\n]+`")
    private static let link = re(#"\[([^\]\n]+)\]\(([^)\s]+)\)"#)
    private static let bold = re(#"\*\*(.+?)\*\*|__(.+?)__"#)
    private static let italic = re(#"\*([^*\s][^*]*?)\*|(^|[^\p{L}\p{N}_])_([^_\s][^_]*?)_($|[^\p{L}\p{N}_])"#)
    private static let list = re(#"^(\s*)[-*+]\s+"#)
    private static let head = re(#"^#{1,6}\s+"#)

    private static func replace(_ r: NSRegularExpression, in s: String, with t: String) -> String {
        r.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: t)
    }

    public static func strip(_ s: String) -> String {
        var out: [String] = []
        var fenced = false
        for line in s.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                fenced.toggle()
                continue
            }
            if fenced {
                out.append(line)
                continue
            }
            var l = replace(head, in: line, with: "")
            l = replace(list, in: l, with: "$1• ")
            out.append(inline(l))
        }
        return out.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func inline(_ l: String) -> String {
        var result = ""
        var last = l.startIndex
        for m in code.matches(in: l, range: NSRange(l.startIndex..., in: l)) {
            guard let r = Range(m.range, in: l) else { continue }
            result += marks(String(l[last..<r.lowerBound]))
            result += String(l[l.index(after: r.lowerBound)..<l.index(before: r.upperBound)])
            last = r.upperBound
        }
        return result + marks(String(l[last...]))
    }

    private static func marks(_ text: String) -> String {
        var s = replace(link, in: text, with: "$1")
        s = replace(bold, in: s, with: "$1$2")
        // Twice: a match consumes its neighbours, so "_a_ _b_" needs a second pass.
        for _ in 0..<2 { s = replace(italic, in: s, with: "$1$2$3$4") }
        return s
    }
}
