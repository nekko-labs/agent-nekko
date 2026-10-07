import Foundation
import NekkoProtocol

/// Never follow redirects: a bearer must not travel to a different endpoint.
final class HostClient: NSObject, URLSessionTaskDelegate {
    private let connection: HostConnection
    private var session: URLSession!

    init(connection: HostConnection) {
        self.connection = connection
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForResource = 45
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    func close() { session.invalidateAndCancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func summaries() async throws -> [SessionSummary] {
        let (data, response) = try await session.data(for: connection.summariesRequest())
        return try HostResponse.decode([SessionSummary].self, data: data, response: response)
            .filter(\.isVisible).sorted { $0.updatedAt > $1.updatedAt }
    }

    func read(id: String) async throws -> Session? {
        let (data, response) = try await session.data(for: connection.sessionRequest(id: id))
        return try HostResponse.decode(Session?.self, data: data, response: response)
    }
}
