import UIKit
import UniformTypeIdentifiers

/// The system share sheet and file picker, for exporting and importing messages
/// (`honk.export`, `honk.import`). nsh has neither, so the host does it.
@MainActor
enum FileExchange {
    /// The view controller that presents: the key window's, or whatever it presents on top.
    static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive } ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController ?? scene?.windows.first?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    /// Writes `data` to a temporary file named `name` and offers it in the share sheet. Resolves when the sheet is
    /// dismissed: whether the user shared or saved it, or not.
    static func share(_ data: Data, name: String) async throws -> Bool {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("export-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent(name)
        try data.write(to: file, options: .atomic)
        defer { try? FileManager.default.removeItem(at: dir) }
        guard let top = topViewController() else { throw ExchangeError.noScreen }
        return await withCheckedContinuation { cont in
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.completionWithItemsHandler = { _, completed, _, _ in cont.resume(returning: completed) }
            // iPad shows it as a popover, which needs an anchor: the middle of the screen.
            if let pop = sheet.popoverPresentationController {
                pop.sourceView = top.view
                pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            top.present(sheet, animated: true)
        }
    }

    /// Lets the user pick a file; its contents, or nil when they cancel. At most 64 MB.
    static func pickFile() async throws -> Data? {
        guard let top = topViewController() else { throw ExchangeError.noScreen }
        let url: URL? = await withCheckedContinuation { cont in
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
            let delegate = PickerDelegate(cont)
            picker.delegate = delegate
            // The picker keeps its delegate weakly: hold it until it answers.
            current = delegate
            top.present(picker, animated: true)
        }
        current = nil
        guard let url else { return nil }
        defer { try? FileManager.default.removeItem(at: url) }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= 64 << 20 else { throw ExchangeError.tooLarge }
        return try Data(contentsOf: url)
    }

    private static var current: PickerDelegate?

    private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
        private var cont: CheckedContinuation<URL?, Never>?

        init(_ cont: CheckedContinuation<URL?, Never>) { self.cont = cont }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            cont?.resume(returning: urls.first)
            cont = nil
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            cont?.resume(returning: nil)
            cont = nil
        }
    }

    enum ExchangeError: Error, LocalizedError {
        case noScreen, tooLarge
        var errorDescription: String? {
            switch self {
            case .noScreen: return "nothing to present on"
            case .tooLarge: return "the file is larger than 64 MB"
            }
        }
    }
}
