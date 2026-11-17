import Foundation
import SQLite3

/// A message as kept on the device.
public struct StoredMessage: Codable, Equatable, Sendable {
    public var id: Int64
    public var botID: Int64
    public var title: String
    public var body: String
    public var html: String
    public var data: String
    public var level: String
    public var group: String
    public var url: String
    public var copy: String
    public var icon: String
    public var collapseID: String
    public var date: Int64
    public var read: Bool
}

/// One row of the chat list: a bot with its latest message and unread count.
public struct ChatSummary: Codable, Equatable, Sendable {
    public var bot: Bot
    public var muted: Bool
    public var pinned: Bool
    public var last: StoredMessage?
    public var unread: Int
}

/// What applying a queued item changed.
public struct ApplyResult: Equatable, Sendable {
    /// The message the item created or changed, if it is still stored.
    public var message: StoredMessage?
    /// Delivered notifications that no longer have a message: remove them.
    public var staleNotificationIDs: [String] = []
}

public enum StoreError: Error {
    case sqlite(String)
}

/// The device's SQLite database. The app and the Notification Service
/// Extension open the same file in the App Group container; WAL mode and a
/// busy timeout let the two processes share it.
public final class LocalStore: @unchecked Sendable {
    private var db: OpaquePointer?
    private let lock = NSLock()

    public init(path: String) throws {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(handle)
            throw StoreError.sqlite(msg)
        }
        db = handle
        sqlite3_busy_timeout(db, 5000)
        try exec("PRAGMA journal_mode = WAL")
        try exec("PRAGMA foreign_keys = ON")
        try migrate()
    }

    /// Opens the store in an App Group container.
    public convenience init(appGroup: String) throws {
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            throw StoreError.sqlite("no container for app group \(appGroup)")
        }
        try self.init(path: dir.appendingPathComponent("honk.sqlite").path)
    }

    deinit { sqlite3_close(db) }

    private func migrate() throws {
        guard try scalar("PRAGMA user_version") ?? 0 < 1 else { return }
        // The app and the extension may open a new file at the same moment:
        // read the version again under the write lock, so the second waits for
        // the first and then finds the tables already there.
        try transaction {
            guard try scalar("PRAGMA user_version") ?? 0 < 1 else { return }
            try exec("""
            CREATE TABLE bots (
              id            INTEGER PRIMARY KEY,
              name          TEXT NOT NULL,
              avatar        TEXT NOT NULL DEFAULT '',
              default_level TEXT NOT NULL DEFAULT 'active',
              muted         INTEGER NOT NULL DEFAULT 0,
              pinned        INTEGER NOT NULL DEFAULT 0,
              created_at    INTEGER NOT NULL DEFAULT 0,
              updated_at    INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE messages (
              id          INTEGER PRIMARY KEY,         -- the gateway's message id
              bot_id      INTEGER NOT NULL,
              title       TEXT NOT NULL DEFAULT '',
              body        TEXT NOT NULL DEFAULT '',
              html        TEXT NOT NULL DEFAULT '',
              data        TEXT NOT NULL DEFAULT '',
              level       TEXT NOT NULL DEFAULT '',
              group_key   TEXT NOT NULL DEFAULT '',
              url         TEXT NOT NULL DEFAULT '',
              copy_text   TEXT NOT NULL DEFAULT '',
              icon        TEXT NOT NULL DEFAULT '',
              collapse_id TEXT NOT NULL DEFAULT '',
              date        INTEGER NOT NULL,
              read        INTEGER NOT NULL DEFAULT 0,
              notif_id    TEXT                         -- the delivered notification's request identifier
            );
            CREATE INDEX messages_bot ON messages(bot_id, id);
            CREATE INDEX messages_collapse ON messages(bot_id, collapse_id) WHERE collapse_id <> '';
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 1;
            """)
        }
    }

    // MARK: applying queued items

    /// Applies an item from the gateway. Safe to call twice with the same item
    /// (the extension and a later sync may both see it).
    @discardableResult
    public func apply(_ m: QueuedMessage, notificationID: String? = nil) throws -> ApplyResult {
        try locked {
            try transaction {
                switch m.kind {
                case .message: return try insert(m, notificationID: notificationID)
                case .edit: return try edit(m)
                case .delete: return try remove(m)
                }
            }
        }
    }

    private func insert(_ m: QueuedMessage, notificationID: String?) throws -> ApplyResult {
        var result = ApplyResult()
        if !m.collapseID.isEmpty {
            // A newer message with the same id replaces older ones.
            let older = try query("SELECT id, notif_id FROM messages WHERE bot_id = ? AND collapse_id = ? AND id <> ?",
                                  [m.botID, m.collapseID, m.id]) { ($0.int(0), $0.text(1)) }
            for (id, notif) in older {
                if let notif, notif != notificationID { result.staleNotificationIDs.append(notif) }
                try run("DELETE FROM messages WHERE id = ?", [id])
            }
        }
        try run("""
            INSERT INTO messages (id, bot_id, title, body, html, data, level, group_key, url, copy_text, icon, collapse_id, date, notif_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, notif_id = COALESCE(messages.notif_id, excluded.notif_id)
            """, [m.id, m.botID, m.title, m.body, m.html, m.data, m.level, m.group, m.url, m.copy, m.icon, m.collapseID,
                  m.date, notificationID])
        result.message = try message(id: m.id)
        return result
    }

    /// The stored message an edit or delete points at: by id, else the latest with the collapse id.
    private func target(_ m: QueuedMessage) throws -> Int64? {
        if m.targetID > 0, try scalar("SELECT id FROM messages WHERE id = ? AND bot_id = ?", [m.targetID, m.botID]) != nil {
            return m.targetID
        }
        if !m.collapseID.isEmpty {
            return try scalar("SELECT id FROM messages WHERE bot_id = ? AND collapse_id = ? ORDER BY id DESC LIMIT 1",
                              [m.botID, m.collapseID])
        }
        return nil
    }

    private func edit(_ m: QueuedMessage) throws -> ApplyResult {
        guard let id = try target(m) else { return ApplyResult() }
        try run("UPDATE messages SET data = ? WHERE id = ?", [m.data, id])
        return ApplyResult(message: try message(id: id))
    }

    private func remove(_ m: QueuedMessage) throws -> ApplyResult {
        guard let id = try target(m) else { return ApplyResult() }
        let notif = try query("SELECT notif_id FROM messages WHERE id = ?", [id]) { $0.text(0) }.first ?? nil
        try run("DELETE FROM messages WHERE id = ?", [id])
        return ApplyResult(message: nil, staleNotificationIDs: notif.map { [$0] } ?? [])
    }

    // MARK: bots

    /// Replaces the stored bots with the gateway's list, keeping local flags and
    /// dropping messages of bots that are gone.
    public func replaceBots(_ bots: [Bot]) throws {
        try locked {
            try transaction {
                for b in bots { try upsert(b) }
                let ids = bots.map { String($0.id) }.joined(separator: ",")
                let keep = ids.isEmpty ? "" : " WHERE id NOT IN (\(ids))"
                let keepMsg = ids.isEmpty ? "" : " WHERE bot_id NOT IN (\(ids))"
                try exec("DELETE FROM messages" + keepMsg)
                try exec("DELETE FROM bots" + keep)
            }
        }
    }

    public func saveBot(_ b: Bot) throws {
        try locked { try upsert(b) }
    }

    private func upsert(_ b: Bot) throws {
        try run("""
            INSERT INTO bots (id, name, avatar, default_level, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar,
              default_level = excluded.default_level, updated_at = excluded.updated_at
            """, [b.id, b.name, b.avatar, b.defaultLevel, b.createdAt, b.updatedAt])
    }

    public func bot(id: Int64) throws -> Bot? {
        try locked {
            try query("SELECT id, name, avatar, default_level, created_at, updated_at FROM bots WHERE id = ?", [id]) {
                Bot(id: $0.int(0), name: $0.text(1) ?? "", avatar: $0.text(2) ?? "", defaultLevel: $0.text(3) ?? "active",
                    createdAt: $0.int(4), updatedAt: $0.int(5))
            }.first
        }
    }

    public func deleteBot(id: Int64) throws {
        try locked {
            try transaction {
                try run("DELETE FROM messages WHERE bot_id = ?", [id])
                try run("DELETE FROM bots WHERE id = ?", [id])
            }
        }
    }

    public func setMuted(botID: Int64, _ muted: Bool) throws {
        try locked { try run("UPDATE bots SET muted = ? WHERE id = ?", [muted, botID]) }
    }

    public func setPinned(botID: Int64, _ pinned: Bool) throws {
        try locked { try run("UPDATE bots SET pinned = ? WHERE id = ?", [pinned, botID]) }
    }

    public func isMuted(botID: Int64) throws -> Bool {
        try locked { try scalar("SELECT muted FROM bots WHERE id = ?", [botID]) == 1 }
    }

    // MARK: reading

    private static let messageCols = "id, bot_id, title, body, html, data, level, group_key, url, copy_text, icon, collapse_id, date, read"

    private static func readMessage(_ r: Row) -> StoredMessage {
        StoredMessage(id: r.int(0), botID: r.int(1), title: r.text(2) ?? "", body: r.text(3) ?? "", html: r.text(4) ?? "",
                      data: r.text(5) ?? "", level: r.text(6) ?? "", group: r.text(7) ?? "", url: r.text(8) ?? "",
                      copy: r.text(9) ?? "", icon: r.text(10) ?? "", collapseID: r.text(11) ?? "", date: r.int(12),
                      read: r.int(13) != 0)
    }

    public func message(id: Int64) throws -> StoredMessage? {
        try query("SELECT \(Self.messageCols) FROM messages WHERE id = ?", [id], Self.readMessage).first
    }

    /// A bot's messages, newest first, older than `before` when given.
    public func messages(botID: Int64, before: Int64? = nil, limit: Int = 50) throws -> [StoredMessage] {
        try locked {
            try query("SELECT \(Self.messageCols) FROM messages WHERE bot_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                      [botID, before ?? Int64.max, limit], Self.readMessage)
        }
    }

    /// The chat list: pinned first, then by latest message.
    public func chats() throws -> [ChatSummary] {
        try locked {
            let bots = try query("""
                SELECT b.id, b.name, b.avatar, b.default_level, b.created_at, b.updated_at, b.muted, b.pinned,
                       (SELECT COUNT(*) FROM messages m WHERE m.bot_id = b.id AND m.read = 0),
                       (SELECT MAX(id) FROM messages m WHERE m.bot_id = b.id)
                FROM bots b
                """) { r in
                (ChatSummary(bot: Bot(id: r.int(0), name: r.text(1) ?? "", avatar: r.text(2) ?? "",
                                      defaultLevel: r.text(3) ?? "active", createdAt: r.int(4), updatedAt: r.int(5)),
                             muted: r.int(6) != 0, pinned: r.int(7) != 0, last: nil, unread: Int(r.int(8))),
                 r.isNull(9) ? nil : r.int(9))
            }
            var out: [ChatSummary] = []
            for (var chat, lastID) in bots {
                if let lastID { chat.last = try message(id: lastID) }
                out.append(chat)
            }
            return out.sorted {
                if $0.pinned != $1.pinned { return $0.pinned }
                return ($0.last?.date ?? $0.bot.createdAt) > ($1.last?.date ?? $1.bot.createdAt)
            }
        }
    }

    public func unreadTotal() throws -> Int {
        try locked {
            Int(try scalar("SELECT COUNT(*) FROM messages m JOIN bots b ON b.id = m.bot_id WHERE m.read = 0 AND b.muted = 0") ?? 0)
        }
    }

    /// How many of a bot's messages are unread.
    public func unreadCount(botID: Int64) throws -> Int {
        try locked { Int(try scalar("SELECT COUNT(*) FROM messages WHERE bot_id = ? AND read = 0", [botID]) ?? 0) }
    }

    /// Marks a bot's messages read and returns their notification ids, to clear them.
    @discardableResult
    public func markRead(botID: Int64) throws -> [String] {
        try locked {
            try transaction {
                let ids = try query("SELECT notif_id FROM messages WHERE bot_id = ? AND read = 0 AND notif_id IS NOT NULL",
                                    [botID]) { $0.text(0) }.compactMap { $0 }
                try run("UPDATE messages SET read = 1 WHERE bot_id = ? AND read = 0", [botID])
                return ids
            }
        }
    }

    /// Deletes one message on this device only; returns its notification id.
    @discardableResult
    public func deleteMessage(id: Int64) throws -> String? {
        try locked {
            let notif = try query("SELECT notif_id FROM messages WHERE id = ?", [id]) { $0.text(0) }.first ?? nil
            try run("DELETE FROM messages WHERE id = ?", [id])
            return notif
        }
    }

    /// Deletes a bot's messages on this device; returns their notification ids.
    @discardableResult
    public func clearMessages(botID: Int64) throws -> [String] {
        try locked {
            try transaction {
                let ids = try query("SELECT notif_id FROM messages WHERE bot_id = ? AND notif_id IS NOT NULL", [botID]) {
                    $0.text(0)
                }.compactMap { $0 }
                try run("DELETE FROM messages WHERE bot_id = ?", [botID])
                return ids
            }
        }
    }

    /// Forgets every bot, message and the sync cursor: the device moved to
    /// another gateway. Returns the notification ids to remove.
    @discardableResult
    public func reset() throws -> [String] {
        try locked {
            try transaction {
                let ids = try query("SELECT notif_id FROM messages WHERE notif_id IS NOT NULL") { $0.text(0) }.compactMap { $0 }
                try exec("DELETE FROM messages; DELETE FROM bots; DELETE FROM meta;")
                return ids
            }
        }
    }

    // MARK: meta

    public var syncCursor: Int64 {
        get { (try? locked { try query("SELECT value FROM meta WHERE key = 'cursor'") { $0.text(0) }.first ?? nil })
            .flatMap { $0 }.flatMap { Int64($0) } ?? 0 }
    }

    public func setSyncCursor(_ c: Int64) throws {
        try locked {
            try run("INSERT INTO meta (key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [String(c)])
        }
    }

    // MARK: SQLite plumbing

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private func error() -> StoreError { .sqlite(String(cString: sqlite3_errmsg(db))) }

    private func exec(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw error() }
    }

    private var inTransaction = false

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        if inTransaction { return try body() }
        try exec("BEGIN IMMEDIATE")
        inTransaction = true
        defer { inTransaction = false }
        do {
            let v = try body()
            try exec("COMMIT")
            return v
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    struct Row {
        let stmt: OpaquePointer
        func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
        func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }
        func text(_ i: Int32) -> String? {
            guard let c = sqlite3_column_text(stmt, i) else { return nil }
            return String(cString: c)
        }
    }

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func prepare(_ sql: String, _ args: [Any?]) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw error() }
        for (i, a) in args.enumerated() {
            let idx = Int32(i + 1)
            switch a {
            case nil: sqlite3_bind_null(stmt, idx)
            case let v as Int64: sqlite3_bind_int64(stmt, idx, v)
            case let v as Int: sqlite3_bind_int64(stmt, idx, Int64(v))
            case let v as Bool: sqlite3_bind_int64(stmt, idx, v ? 1 : 0)
            case let v as String: sqlite3_bind_text(stmt, idx, v, -1, Self.transient)
            default:
                sqlite3_finalize(stmt)
                throw StoreError.sqlite("unsupported argument \(String(describing: a))")
            }
        }
        return stmt
    }

    private func run(_ sql: String, _ args: [Any?] = []) throws {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw error() }
    }

    private func query<T>(_ sql: String, _ args: [Any?] = [], _ map: (Row) throws -> T) throws -> [T] {
        let stmt = try prepare(sql, args)
        defer { sqlite3_finalize(stmt) }
        var out: [T] = []
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_DONE { break }
            guard rc == SQLITE_ROW else { throw error() }
            out.append(try map(Row(stmt: stmt)))
        }
        return out
    }

    private func scalar(_ sql: String, _ args: [Any?] = []) throws -> Int64? {
        try query(sql, args) { $0.isNull(0) ? nil : $0.int(0) }.first ?? nil
    }
}
