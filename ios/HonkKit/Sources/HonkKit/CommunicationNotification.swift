#if os(iOS)
import Intents
import UIKit
import UserNotifications

/// Turns a plain notification into a communication notification (iOS 15+):
/// the banner shows the bot's avatar and name like a chat message.
///
/// Needs the Communication Notifications capability on the app and
/// `INSendMessageIntent` in the app's and the extension's `NSUserActivityTypes`/
/// `IntentsSupported`.
public enum CommunicationNotification {
    public static func render(_ avatar: Avatar, imageData: Data?, size: CGFloat = 120) -> Data? {
        switch avatar {
        case .image, .local:
            if let imageData, UIImage(data: imageData) != nil { return imageData }
        case .preset:
            break
        }
        let (icon, color): (String, String)
        if case let .preset(i, c) = avatar { (icon, color) = (i, c) } else { (icon, color) = ("bell", "#0a6ed1") }
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        let image = renderer.image { ctx in
            UIColor(hex: color).setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: size, height: size))
            let config = UIImage.SymbolConfiguration(pointSize: size * 0.42, weight: .semibold)
            if let symbol = UIImage(systemName: Avatar.symbols[icon] ?? "bell.fill", withConfiguration: config)?
                .withTintColor(.white, renderingMode: .alwaysOriginal) {
                let s = symbol.size
                symbol.draw(in: CGRect(x: (size - s.width) / 2, y: (size - s.height) / 2, width: s.width, height: s.height))
            }
        }
        return image.pngData()
    }

    /// Returns `content` updated from an incoming-message intent. Falls back to
    /// `content` unchanged if the system refuses it.
    public static func content(_ content: UNNotificationContent, botID: String, botName: String, title: String,
                               body: String, avatarPNG: Data?) -> UNNotificationContent {
        let image = avatarPNG.map { INImage(imageData: $0) }
        let handle = INPersonHandle(value: "bot-\(botID)", type: .unknown)
        let sender = INPerson(personHandle: handle, nameComponents: nil, displayName: botName, image: image,
                              contactIdentifier: nil, customIdentifier: "bot-\(botID)")
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
                                         content: body, speakableGroupName: nil,
                                         conversationIdentifier: "bot-\(botID)", serviceName: nil,
                                         sender: sender, attachments: nil)
        if let image { intent.setImage(image, forParameterNamed: \.sender) }
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)
        guard let updated = try? content.updating(from: intent) else { return content }
        if !title.isEmpty, let m = updated.mutableCopy() as? UNMutableNotificationContent {
            m.subtitle = title
            return m
        }
        return updated
    }
}

extension UIColor {
    convenience init(hex: String) {
        var v: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&v)
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                  blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}
#endif
