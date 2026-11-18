import Foundation

/// Messages as JSON Lines: one JSON object per line, in the shape of the
/// message objects of the gateway's App API (`message_id`, `bot_id`, `kind`,
/// `title`, `body`, `html`, `data`, `level`, `group`, `url`, `copy`, `icon`,
/// `id` (the collapse id), `date`), with empty fields left out. A line is a
/// `QueuedMessage`, so an archive imports through `LocalStore.importMessages`.
/// Same as `MessageArchive.kt` in the Android core.
public enum MessageArchive {
    /// The file name an export is saved under, such as `honk-all-20260102.jsonl`.
    public static func fileName(botName: String?, now: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd"
        let safe = (botName ?? "all").unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
        let name = String(safe).split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return "honk-\(name.isEmpty ? "bot" : name)-\(f.string(from: now)).jsonl"
    }

    private struct Line: Encodable {
        var message_id: Int64
        var bot_id: String
        var kind = "message"
        var title: String?
        var body: String?
        var html: String?
        var data: String?
        var level: String?
        var group: String?
        var url: String?
        var copy: String?
        var icon: String?
        var id: String?
        var date: Int64
    }

    private static func opt(_ s: String) -> String? { s.isEmpty ? nil : s }

    /// The archive of `messages`, one line each, in the order given.
    public static func encode(_ messages: [StoredMessage]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var out = Data()
        for m in messages {
            let line = Line(message_id: m.id, bot_id: m.botID, title: opt(m.title), body: opt(m.body), html: opt(m.html),
                            data: opt(m.data), level: opt(m.level), group: opt(m.group), url: opt(m.url), copy: opt(m.copy),
                            icon: opt(m.icon), id: opt(m.collapseID), date: m.date)
            out.append(try encoder.encode(line))
            out.append(0x0A)
        }
        return out
    }

    /// What `decode` read: the messages, and how many non-empty lines it could not read.
    public struct Decoded: Equatable {
        public var messages: [QueuedMessage]
        public var invalid: Int
    }

    /// Reads an archive; a line that is not a message object is counted, not fatal.
    public static func decode(_ data: Data) -> Decoded {
        let decoder = JSONDecoder()
        var out = Decoded(messages: [], invalid: 0)
        for raw in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
            let line = raw.last == 0x0D ? raw.dropLast() : raw
            if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 }) { continue }
            if let m = try? decoder.decode(QueuedMessage.self, from: Data(line)), m.id > 0, !m.botID.isEmpty {
                out.messages.append(m)
            } else {
                out.invalid += 1
            }
        }
        return out
    }
}
