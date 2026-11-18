import Foundation

/// A download that enforces its limits while it streams: the declared
/// `Content-Length` is checked before any body arrives, the transfer is
/// cancelled as soon as more than `maxBytes` came in, and `deadline` bounds
/// the whole transfer (not only the gaps between packets, as a request
/// timeout does). Used for images in the Notification Service Extension,
/// whose time budget is short.
enum CappedDownload {
    /// The body and response of a 200 within the limits, else `nil`.
    static func fetch(_ request: URLRequest, session base: URLSession, maxBytes: Int, deadline: TimeInterval) async -> (Data, HTTPURLResponse)? {
        let delegate = Delegate(maxBytes: maxBytes)
        let config = base.configuration
        config.timeoutIntervalForResource = deadline
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                delegate.start(session.dataTask(with: request), continuation)
            }
        } onCancel: {
            delegate.cancel()
        }
    }

    private final class Delegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        private let maxBytes: Int
        private let lock = NSLock()
        private var data = Data()
        private var response: HTTPURLResponse?
        private var task: URLSessionDataTask?
        private var continuation: CheckedContinuation<(Data, HTTPURLResponse)?, Never>?
        private var done = false

        init(maxBytes: Int) { self.maxBytes = maxBytes }

        func start(_ task: URLSessionDataTask, _ continuation: CheckedContinuation<(Data, HTTPURLResponse)?, Never>) {
            lock.lock()
            self.task = task
            self.continuation = continuation
            let cancelled = done
            lock.unlock()
            if cancelled { finish(nil) } else { task.resume() }
        }

        func cancel() {
            lock.lock()
            done = true
            let t = task
            lock.unlock()
            t?.cancel()
            finish(nil)
        }

        private func finish(_ result: (Data, HTTPURLResponse)?) {
            lock.lock()
            let c = continuation
            continuation = nil
            lock.unlock()
            c?.resume(returning: result)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.expectedContentLength <= Int64(maxBytes) else { // -1 when unknown: the stream is checked below
                completionHandler(.cancel)
                finish(nil)
                return
            }
            lock.lock()
            self.response = http
            lock.unlock()
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
            lock.lock()
            data.append(chunk)
            let tooBig = data.count > maxBytes
            lock.unlock()
            if tooBig {
                dataTask.cancel()
                finish(nil)
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let body = data
            let http = response
            lock.unlock()
            if error == nil, let http { finish((body, http)) } else { finish(nil) }
        }
    }
}
