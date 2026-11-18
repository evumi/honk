import Foundation
import HonkCardC

/// Runs card scripts (native/card) for the nsh app: one QuickJS runtime per
/// card, all on one serial background queue, with their timers driven from
/// there. The app talks to it through the host calls honk.card.open, .click,
/// .set and .close, and hears timer changes as honk.card.changed.
///
/// Strings in and out are JSON (see honk_card.h); this class only keeps cards,
/// schedules ticks and drops the least recently used cards past `maxCards` or `memoryBudget`.
public final class CardHost: @unchecked Sendable {
    /// Cards kept at once; opening one more closes the least recently used.
    public static let maxCards = 8
    /// Heap of all cards together; past it the least recently used other cards are closed.
    public static let memoryBudget: UInt = 32 * 1024 * 1024

    private let queue = DispatchQueue(label: "honk.cards", qos: .userInitiated)
    private var cards: [String: OpaquePointer] = [:]
    private var used: [String] = []
    private var timers: [String: DispatchWorkItem] = [:]
    /// Keys closed lately: an open that arrives after its close (host calls are not ordered) is refused.
    private var closed: [String] = []
    private let changed: @Sendable (_ key: String, _ result: String) -> Void

    /// `changed` gets a card's result after a timer changed it, on the card queue.
    public init(changed: @escaping @Sendable (_ key: String, _ result: String) -> Void) {
        self.changed = changed
    }

    deinit {
        // Nothing else holds the host now (queued blocks hold it strongly), so no queue hop:
        // deinit may even run on the queue itself.
        for t in timers.values { t.cancel() }
        for c in cards.values { honk_card_close(c) }
    }

    public func open(key: String, load: String) async -> String {
        await run {
            if self.closed.contains(key) { return #"{"tree":null,"prevented":false,"stopped":"closed","logs":[]}"# }
            self.closeNow(key)
            while self.cards.count >= Self.maxCards, let oldest = self.used.first { self.closeNow(oldest) }
            var result: UnsafeMutablePointer<CChar>?
            guard let card = honk_card_open(load, nil, &result) else {
                return #"{"tree":null,"prevented":false,"stopped":"error","logs":["no runtime"]}"#
            }
            self.cards[key] = card
            self.touch(key)
            self.schedule(key)
            self.keepWithinBudget(sparing: key)
            return Self.take(result)
        }
    }

    public func click(key: String, path: String) async -> String {
        await call(key) { honk_card_click($0, path) }
    }

    public func set(key: String, state: String) async -> String {
        await call(key) { honk_card_set($0, state) }
    }

    public func close(key: String) async {
        await run {
            self.closeNow(key)
            self.closed.append(key)
            if self.closed.count > 256 { self.closed.removeFirst(self.closed.count - 256) }
        }
    }

    /// Cards open now (for tests).
    public var count: Int {
        queue.sync { cards.count }
    }

    // MARK: on the queue

    private func run<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> T {
        await withCheckedContinuation { cont in
            queue.async { cont.resume(returning: body()) }
        }
    }

    private func call(_ key: String, _ body: @escaping @Sendable (OpaquePointer) -> UnsafeMutablePointer<CChar>?) async -> String {
        await run {
            guard let card = self.cards[key] else {
                return #"{"tree":null,"prevented":false,"stopped":"closed","logs":[]}"#
            }
            self.touch(key)
            let result = Self.take(body(card))
            self.schedule(key)
            self.keepWithinBudget(sparing: key)
            return result
        }
    }

    private func touch(_ key: String) {
        used.removeAll { $0 == key }
        used.append(key)
    }

    /// Closes the least recently used cards (never `key`) while all cards together hold more than the budget.
    private func keepWithinBudget(sparing key: String) {
        var total = cards.values.reduce(UInt(0)) { $0 + UInt(honk_card_memory($1)) }
        for other in used where total > Self.memoryBudget && other != key {
            if let card = cards[other] { total -= UInt(honk_card_memory(card)) }
            closeNow(other)
        }
    }

    private func closeNow(_ key: String) {
        timers.removeValue(forKey: key)?.cancel()
        used.removeAll { $0 == key }
        if let card = cards.removeValue(forKey: key) { honk_card_close(card) }
    }

    /// Schedules the card's next tick, replacing one already scheduled.
    private func schedule(_ key: String) {
        timers.removeValue(forKey: key)?.cancel()
        guard let card = cards[key] else { return }
        let next = honk_card_next(card)
        guard next >= 0 else { return }
        let item = DispatchWorkItem { [weak self] in self?.tick(key) }
        timers[key] = item
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(next.rounded(.up))), execute: item)
    }

    private func tick(_ key: String) {
        timers[key] = nil
        guard let card = cards[key] else { return }
        let result = Self.take(honk_card_tick(card))
        schedule(key)
        keepWithinBudget(sparing: key)
        // Only changes are worth a message to the app.
        if !result.hasPrefix(#"{"tree":null,"prevented":false,"stopped":null,"logs":[]}"#) { changed(key, result) }
    }

    private static func take(_ p: UnsafeMutablePointer<CChar>?) -> String {
        guard let p else { return #"{"tree":null,"prevented":false,"stopped":"error","logs":[]}"# }
        defer { honk_card_free_string(p) }
        return String(cString: p)
    }
}
