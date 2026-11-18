import Foundation

/// The text of a message banner: what the Notification Service Extension puts
/// on the notification once it has (or has not) fetched the message.
public struct BannerText: Equatable, Sendable {
    public var botName: String
    public var title: String
    public var body: String

    /// Picks the banner text.
    ///
    /// A push the gateway sent without content (`HONK_PUSH_CONTENT=none`, the
    /// default through a relay) carries only a generic localised body, so the
    /// text has to come from the fetched message and the bot in the local
    /// store; a push with content works as before when the fetch fails.
    ///
    /// - Parameters:
    ///   - message: the message fetched from the gateway, if that worked.
    ///   - bot: the bot's name from the local store, if known.
    ///   - pushTitle, pushSubtitle, pushBody: the push's own alert (bot name,
    ///     message title, body); for a content-less push the body is the
    ///     localised generic text and the others are empty.
    ///   - fallback: the localised "New notification", for when there is
    ///     nothing else to show.
    public static func choose(message: StoredMessage?, botName bot: String?, pushTitle: String,
                              pushSubtitle: String, pushBody: String, fallback: String) -> BannerText {
        let name = [bot, pushTitle].compactMap { $0 }.first { !$0.isEmpty } ?? "Honk"
        guard let message else {
            return BannerText(botName: name, title: pushSubtitle, body: pushBody.isEmpty ? fallback : pushBody)
        }
        let title = message.title.isEmpty ? pushSubtitle : message.title
        let body = [message.body, pushBody].first { !$0.isEmpty } ?? fallback
        return BannerText(botName: name, title: title, body: body)
    }
}
