import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum ConnectionError: Error, LocalizedError {
    case invalidURL, invalidToken, invalidResponse, rejected(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Enter an HTTPS host origin, without a path, query, fragment, or embedded credentials."
        case .invalidToken: return "Enter a non-empty host bearer token without whitespace or control characters."
        case .invalidResponse: return "The host returned an incompatible response."
        case .rejected(let status): return "Host request failed (HTTP \(status)). Check the host address and access token."
        }
    }
}

/// Origin-only URLs avoid ambiguous reverse-proxy paths and accidental credential URLs.
public struct HostConnection: Sendable {
    public let origin: URL
    private let token: String

    public init(origin: String, bearer: String) throws {
        guard let parts = URLComponents(string: origin),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!),
              let url = parts.url else { throw ConnectionError.invalidURL }
        guard !bearer.isEmpty, bearer.unicodeScalars.allSatisfy({
            !CharacterSet.whitespacesAndNewlines.contains($0) && !CharacterSet.controlCharacters.contains($0)
        }) else { throw ConnectionError.invalidToken }
        self.origin = url
        self.token = bearer
    }

    public func summariesRequest() throws -> URLRequest {
        try request(channel: "sessions:summaries", args: [])
    }

    public func sessionRequest(id: String) throws -> URLRequest {
        try request(channel: "session:get", args: [id])
    }

    private func request(channel: String, args: [String]) throws -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent("api").appendingPathComponent(channel))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(Arguments(args: args))
        return request
    }

    private struct Arguments: Encodable { let args: [String] }
}

/// Deliberately narrow projections: unknown host fields are ignored, never persisted.
public struct SessionSummary: Decodable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let updatedAt: Double
    public let messageCount: Int
    public let archivedAt: Double?
    public let parentSessionId: String?
    public let taskId: String?
    public let trainingRunId: String?

    public var isVisible: Bool {
        (archivedAt == nil || archivedAt == 0) && parentSessionId == nil && taskId == nil && trainingRunId == nil
    }
    public var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }
}

public struct Session: Decodable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let messages: [ChatMessage]
}

public struct ChatMessage: Decodable, Identifiable, Sendable {
    public let id: String
    public let role: String
    public let content: String
    public let createdAt: Double
    public let interrupted: Bool?
    public let images: [String]?
    public let toolCalls: [ToolCall]?
    public let toolResult: ToolResult?

    public var createdDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
}

public struct ToolCall: Decodable, Sendable {
    public let id: String
    public let name: String
}

public struct ToolResult: Decodable, Sendable {
    public let output: String
    public let isError: Bool?
}

public enum HostResponse {
    public static func decode<T: Decodable>(_ type: T.Type, data: Data, response: URLResponse) throws -> T {
        guard let http = response as? HTTPURLResponse else { throw ConnectionError.invalidResponse }
        guard http.statusCode == 200 else { throw ConnectionError.rejected(http.statusCode) }
        guard http.mimeType?.lowercased() == "application/json" else { throw ConnectionError.invalidResponse }
        do { return try JSONDecoder().decode(type, from: data) }
        catch { throw ConnectionError.invalidResponse }
    }
}
