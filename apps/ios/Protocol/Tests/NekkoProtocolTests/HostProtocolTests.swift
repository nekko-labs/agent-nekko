import XCTest
@testable import NekkoProtocol
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class HostProtocolTests: XCTestCase {
    func testOnlyExplicitHTTPSOrigins() throws {
        for origin in ["http://host.test", "https://u:p@host.test", "https://host.test/api", "https://host.test?token=x", "https://host.test#x", "https://", "https://host.test:0"] {
            XCTAssertThrowsError(try HostConnection(origin: origin, bearer: "host-token"), origin)
        }
        XCTAssertNoThrow(try HostConnection(origin: "https://host.test:8443/", bearer: "host-token"))
        for token in ["", "a\nb", "a b", "a\rb"] {
            XCTAssertThrowsError(try HostConnection(origin: "https://host.test", bearer: token))
        }
    }

    func testExactHostRequestEnvelope() throws {
        let connection = try HostConnection(origin: "https://host.test", bearer: "host-token")
        let list = try connection.summariesRequest()
        XCTAssertEqual(list.url?.path, "/api/sessions:summaries")
        XCTAssertEqual(list.httpMethod, "POST")
        XCTAssertEqual(list.value(forHTTPHeaderField: "Authorization"), "Bearer host-token")
        XCTAssertNil(list.url?.query)
        XCTAssertEqual(String(data: list.httpBody!, encoding: .utf8), "{\"args\":[]}")
        let get = try connection.sessionRequest(id: "chat-1")
        XCTAssertEqual(get.url?.path, "/api/session:get")
        XCTAssertEqual(String(data: get.httpBody!, encoding: .utf8), "{\"args\":[\"chat-1\"]}")
    }

    func testSummaryProjectionAndMilliseconds() throws {
        let data = Data("""
        [{"id":"c","title":"Chat","updatedAt":1700000000000,"messageCount":2,"providerId":"ignored","recentTurns":[],"unknown":true},
         {"id":"sub","title":"Child","updatedAt":1,"messageCount":0,"parentSessionId":"c"},
         {"id":"archived","title":"Old","updatedAt":1,"messageCount":0,"archivedAt":2}]
        """.utf8)
        let summaries = try JSONDecoder().decode([SessionSummary].self, from: data)
        XCTAssertEqual(summaries.filter(\.isVisible).map(\.id), ["c"])
        XCTAssertEqual(summaries[0].updatedDate.timeIntervalSince1970, 1700000000)
    }

    func testSessionNullAndToolProjection() throws {
        let data = Data("""
        {"id":"c","title":"Chat","messages":[{"id":"m","role":"tool","content":"","createdAt":1000,"toolResult":{"toolCallId":"t","output":"done","isError":false},"extra":"ignored"}]}
        """.utf8)
        let session = try JSONDecoder().decode(Session.self, from: data)
        XCTAssertEqual(session.messages[0].toolResult?.output, "done")
        XCTAssertEqual(session.messages[0].createdDate.timeIntervalSince1970, 1)
        XCTAssertNil(try JSONDecoder().decode(Session?.self, from: Data("null".utf8)))
    }

    func testResponseFailuresDoNotExposeHostBody() throws {
        let url = URL(string: "https://host.test")!
        let denied = HTTPURLResponse(url: url, statusCode: 401, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        XCTAssertThrowsError(try HostResponse.decode(Session.self, data: Data("secret".utf8), response: denied)) { error in
            XCTAssertFalse(error.localizedDescription.contains("secret"))
        }
        let html = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html"])!
        XCTAssertThrowsError(try HostResponse.decode(Session.self, data: Data(), response: html))
        let json = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        XCTAssertThrowsError(try HostResponse.decode(Session.self, data: Data("{}".utf8), response: json))
    }
}
