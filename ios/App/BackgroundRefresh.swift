import BackgroundTasks
import Foundation

/// Refreshes the app in the background, about every six hours when iOS allows:
/// one sync that applies edits and deletes, removes the notifications they made
/// stale and updates the badge. It never posts notifications (iOS shows those
/// only from pushes); a message that arrived without its push appears in the
/// app, and in the badge, from here. The task identifier is
/// `<bundle id>.refresh`, listed under BGTaskSchedulerPermittedIdentifiers in
/// project.yml.
enum BackgroundRefresh {
    static var identifier: String { (Bundle.main.bundleIdentifier ?? "dev.evumi.honk") + ".refresh" }

    /// The earliest the next refresh may start; iOS decides when it really does.
    static let interval: TimeInterval = 6 * 3600

    /// Hands the system the task's handler. Call once, before the app finishes launching.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            let box = TaskBox(refresh)
            Task { @MainActor in await run(box.task) }
        }
    }

    /// Asks for the next refresh; replaces a pending request.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("honk: could not schedule a background refresh: \(error)")
        }
    }

    @MainActor
    private static func run(_ task: BGAppRefreshTask) async {
        schedule() // the next one first, in case this one is cut short
        let sync = Task { @MainActor in await HonkService.shared.refresh() }
        task.expirationHandler = { sync.cancel() }
        await sync.value
        task.setTaskCompleted(success: !sync.isCancelled)
    }

    /// BGTask is not Sendable; the handler only passes it on to the main actor.
    private final class TaskBox: @unchecked Sendable {
        let task: BGAppRefreshTask
        init(_ task: BGAppRefreshTask) { self.task = task }
    }
}
