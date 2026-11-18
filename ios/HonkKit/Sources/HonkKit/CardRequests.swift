import Foundation

/// A card's `request(data)` (native/card), served by the host: the nsh app is not involved.
///
/// A click's result may carry `"request":{"seq":N,"data":"…"}`. `filter` cuts it out of the result the
/// app gets and, in the background, sends the data to the message's bot (`POST /v1/queries`), then
/// hands the reply to the card (`CardHost.answer`) and passes the card's new result on as
/// `honk.card.changed`. Failures reach the card as error codes: `TIMEOUT` (the bot did not answer in
/// time), `NOT_ALLOWED` (the message does not allow queries, or is gone), `NETWORK`, `RATE_LIMITED`,
/// and `REQUEST_FAILED` for anything else.
public final class CardRequests: @unchecked Sendable {
    /// Sends a query and returns the bot's answer.
    public typealias Query = @Sendable (_ messageID: Int64, _ data: String) async throws -> String
    /// Gives the card its answer; returns the card's new result.
    public typealias Answer = @Sendable (_ key: String, _ seq: Int, _ ok: Bool, _ data: String) async -> String
    public typealias Changed = @Sendable (_ key: String, _ result: String) -> Void

    private struct Source { var messageID: Int64; var allowed: Bool }

    private let query: Query
    private let answer: Answer
    private let changed: Changed
    private let lock = NSLock()
    private var sources: [String: Source] = [:]

    public init(query: @escaping Query, answer: @escaping Answer, changed: @escaping Changed) {
        self.query = query
        self.answer = answer
        self.changed = changed
    }

    /// Remembers which message a card shows: its `load` (the app's JSON) has `messageId` and `allowQueries`.
    public func opened(key: String, load: String) {
        var source = Source(messageID: 0, allowed: false)
        if let obj = (try? JSONSerialization.jsonObject(with: Data(load.utf8))) as? [String: Any] {
            source.messageID = (obj["messageId"] as? NSNumber)?.int64Value ?? 0
            source.allowed = (obj["allowQueries"] as? Bool) ?? false
        }
        lock.lock()
        sources[key] = source
        lock.unlock()
    }

    public func closed(key: String) {
        lock.lock()
        sources[key] = nil
        lock.unlock()
    }

    /// Takes the `request` out of a card's result. With one, the query goes out in the background.
    /// Returns the result for the app.
    public func filter(key: String, result: String) -> String {
        guard let (stripped, req) = Self.split(result) else { return result }
        Task { await self.serve(key: key, seq: req.seq, data: req.data) }
        return stripped
    }

    /// Runs one request to its end: query, answer the card, report what the card then drew.
    func serve(key: String, seq: Int, data: String) async {
        lock.lock()
        let source = sources[key]
        lock.unlock()
        var ok = false
        var reply = "NOT_ALLOWED"
        if let source, source.allowed, source.messageID > 0 {
            do {
                reply = try await query(source.messageID, data)
                ok = true
            } catch {
                reply = Self.code(for: error)
            }
        }
        let result = await answer(key, seq, ok, reply)
        // An answer's result is a normal one; it has no request of its own, but cut it out all the same.
        let out = Self.split(result)?.0 ?? result
        if !Self.isEmpty(out) { changed(key, out) }
    }

    /// A result that says nothing: no tree, no link or copy, nothing logged, not stopped.
    static func isEmpty(_ result: String) -> Bool {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(result.utf8))) as? [String: Any] else { return false }
        return obj["tree"] is NSNull && (obj["logs"] as? [Any])?.isEmpty == true && obj["stopped"] is NSNull
            && obj["open"] == nil && obj["copy"] == nil && (obj["prevented"] as? Bool) == false
    }

    /// The error code a card sees for a failed query.
    static func code(for error: Error) -> String {
        if let e = error as? APIError {
            switch e {
            case let .gateway(code, _):
                switch code {
                case 504: return "TIMEOUT"
                case 401, 403, 404: return "NOT_ALLOWED"
                case 429: return "RATE_LIMITED"
                default: return "REQUEST_FAILED"
                }
            case .notRegistered: return "NOT_ALLOWED"
            case .badResponse: return "REQUEST_FAILED"
            }
        }
        if let e = error as? URLError {
            return e.code == .timedOut ? "TIMEOUT" : "NETWORK"
        }
        return "NETWORK"
    }

    /// A result without its `request`, and the request; nil when the result has none.
    static func split(_ result: String) -> (String, (seq: Int, data: String))? {
        guard result.contains(#""request""#),
              var obj = (try? JSONSerialization.jsonObject(with: Data(result.utf8))) as? [String: Any],
              let req = obj.removeValue(forKey: "request") as? [String: Any],
              let seq = (req["seq"] as? NSNumber)?.intValue,
              let data = req["data"] as? String,
              let out = try? JSONSerialization.data(withJSONObject: obj)
        else { return nil }
        return (String(decoding: out, as: UTF8.self), (seq, data))
    }
}

extension APIClient {
    /// A card's query: the bot's answer to `data`, sent for the message `messageID`
    /// (`POST /v1/queries`). The gateway holds the request until the bot answers (up to 15 s).
    public func query(messageID: Int64, data: String) async throws -> String {
        struct Answer: Decodable { let data: String }
        let a: Answer = try await request("POST", "v1/queries", body: ["message_id": messageID, "data": data])
        return a.data
    }

    /// Like `query(messageID:data:)`, with a timeout past the gateway's 15 s wait.
    public func cardQuery(messageID: Int64, data: String) async throws -> String {
        try await APIClient(baseURL: baseURL, secret: secret, session: session, timeout: 20).query(messageID: messageID, data: data)
    }
}
