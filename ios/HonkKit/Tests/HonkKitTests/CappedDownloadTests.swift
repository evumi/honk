import Foundation
import Testing
@testable import HonkKit

extension GatewayTests {
    @Test func imageDownloadsAreCappedAndOnlyJpegPngGifAttach() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let notif = NotificationImage(session: MockGateway.session(), directory: dir)
        let cache = ImageCache(dir: dir.appendingPathComponent("cache"), session: MockGateway.session())
        MockGateway.requests = []
        MockGateway.handler = { req in
            switch req.url!.path {
            case "/ok.gif": return (200, "GIF89a" + String(repeating: "x", count: 100))
            case "/big.gif": return (200, "GIF89a" + String(repeating: "x", count: NotificationPlan.maxImageBytes + 10))
            case "/pic.webp": return (200, "RIFF\u{0}\u{0}\u{0}\u{0}WEBP" + String(repeating: "x", count: 100))
            case "/liar.png": return (200, "<html>not an image</html>")
            default: return (404, "")
            }
        }
        let ok = await notif.download("https://img.test/ok.gif")
        #expect(ok != nil && ok?.pathExtension == "gif")
        #expect(await notif.download("https://img.test/big.gif") == nil, "past the cap the transfer is cut off")
        #expect(await notif.download("https://img.test/pic.webp") == nil, "WebP is not an attachment type")
        #expect(await notif.download("https://img.test/liar.png") == nil, "the bytes must be an image")

        // Avatars: 2 MB cap.
        MockGateway.handler = { req in
            req.url!.path == "/a.png" ? (200, "GIF89a" + String(repeating: "x", count: 100)) : (200, String(repeating: "x", count: (2 << 20) + 1))
        }
        #expect(await cache.data(for: URL(string: "https://img.test/a.png")!) != nil)
        #expect(await cache.data(for: URL(string: "https://img.test/huge.png")!) == nil)
    }
}
