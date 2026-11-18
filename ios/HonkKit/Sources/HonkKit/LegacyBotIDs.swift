import Foundation

/// Moves bots stored under an integer id (from before short ids) to the short
/// id the gateway now lists them by, so their messages, flags and token are not
/// dropped. The same rules as android/core's `LegacyBotIds`:
///
/// 1. With a stored token, ask `getMe` (old tokens keep working) which bot it is.
/// 2. Otherwise, or when the gateway says the token is gone (401/404), match
///    on `created_at` + name when exactly one listed bot, not yet stored, has both.
/// 3. A bot whose `getMe` failed for another reason (offline, timeout, 5xx) and
///    that did not match stays `pending`: keep it (`replaceBots(keeping:)`)
///    and try again next time.
///
/// Delivered notifications are left alone on both platforms; their stored ids
/// still remove them.
/// Drops what this phone keeps for bots the gateway no longer lists.
public enum SecretPruning {
    /// Removes the tokens and end-to-end keys of bots that are not stored any more. Call it after
    /// `LocalStore.replaceBots`, whose list already holds the legacy-id bots still pending a rename
    /// (`LegacyBotIDs`), so those keep their token. The secrets are listed before the store is, so a bot added
    /// meanwhile (its row is stored before its token) is never mistaken for an orphan.
    public static func prune(store: LocalStore, tokens: BotTokenStoring, keys: BotKeyStoring) throws {
        let tokenIDs = tokens.ids()
        let keyIDs = keys.ids()
        let keep = Set(try store.botIDs())
        for id in tokenIDs where !keep.contains(id) { tokens.remove(botID: id) }
        for id in keyIDs where !keep.contains(id) { keys.remove(botID: id) }
    }
}

public enum LegacyBotIDs {
    public struct Outcome: Equatable, Sendable {
        /// (old id, new id) pairs.
        public var renamed: [Rename] = []
        /// Legacy ids to keep for another try.
        public var pending: Set<String> = []
    }

    public struct Rename: Equatable, Sendable {
        public var old: String
        public var new: String
    }

    /// Renames what it can against the gateway's bot list.
    public static func rename(store: LocalStore, tokens: BotTokenStoring, serverBots: [Bot],
                              getMe: (String) async throws -> Bot) async -> Outcome {
        var out = Outcome()
        guard let local = try? store.bots() else { return out }
        let known = Set(serverBots.map(\.id))
        let legacy = local.filter { BotID.isLegacy($0.id) && !known.contains($0.id) }
        guard !legacy.isEmpty else { return out }
        let stored = Set(local.map(\.id))
        var claimed = Set<String>()

        for bot in legacy {
            var newID: String?
            var transient = false
            var answered = false // getMe named the bot: no guessing by name then
            let token = tokens.token(botID: bot.id)
            if let token {
                do {
                    let me = try await getMe(token)
                    answered = true
                    if known.contains(me.id) { newID = me.id }
                } catch let APIError.gateway(code, _) where code == 401 || code == 404 {
                    // The token no longer names a bot.
                } catch {
                    transient = true
                }
            }
            if newID == nil, !answered {
                let twins = legacy.filter { $0.createdAt == bot.createdAt && $0.name == bot.name }
                let matches = serverBots.filter {
                    !stored.contains($0.id) && !claimed.contains($0.id) && $0.createdAt == bot.createdAt && $0.name == bot.name
                }
                if twins.count == 1, matches.count == 1 { newID = matches[0].id }
            }
            guard let newID, !claimed.contains(newID) else {
                if transient { out.pending.insert(bot.id) }
                continue
            }
            guard (try? store.renameBot(from: bot.id, to: newID)) == true else {
                if transient { out.pending.insert(bot.id) }
                continue
            }
            claimed.insert(newID)
            if let token {
                // A token saved under the short id meanwhile (a reset) is newer.
                if tokens.token(botID: newID) == nil { tokens.save(token, botID: newID) }
                tokens.remove(botID: bot.id)
            }
            out.renamed.append(Rename(old: bot.id, new: newID))
        }
        return out
    }

    /// Whether any stored bot still has a legacy id.
    public static func hasLegacy(_ store: LocalStore) -> Bool {
        ((try? store.botIDs()) ?? []).contains(where: BotID.isLegacy)
    }

    /// For a push: while legacy-id bots are stored, fetch the bot list and
    /// rename first, so the push finds its bot's name, avatar and mute flag
    /// (a refresh may already have stored the short id while the legacy row
    /// was pending). The list is then applied as a refresh would, so legacy
    /// rows that match nothing go and later pushes skip all this. Pass a client
    /// with a short timeout: the extension has about 30 seconds in all.
    /// Returns quietly on any failure.
    public static func renameBeforePush(store: LocalStore, tokens: BotTokenStoring, api: APIClient) async {
        guard hasLegacy(store), let bots = try? await api.listBots() else { return }
        let out = await rename(store: store, tokens: tokens, serverBots: bots) { try await api.getMe(token: $0) }
        try? store.replaceBots(bots, keeping: out.pending)
    }
}
