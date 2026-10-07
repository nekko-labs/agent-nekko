import XCTest
@testable import NekkoNative

final class NativeStorageTests: XCTestCase {
    func testDeviceKeychainRoundTripAndReplacement() throws {
        try CredentialStore.delete()
        defer { try? CredentialStore.delete() }
        XCTAssertNil(try CredentialStore.read())
        try CredentialStore.save("synthetic-first")
        XCTAssertEqual(try CredentialStore.read(), "synthetic-first")
        try CredentialStore.save("synthetic-replacement")
        XCTAssertEqual(try CredentialStore.read(), "synthetic-replacement")
        try CredentialStore.delete()
        XCTAssertNil(try CredentialStore.read())
    }

    @MainActor
    func testSavedBearerCannotMoveToAnotherHost() async throws {
        try CredentialStore.save("synthetic-host-token")
        UserDefaults.standard.set("https://original.invalid", forKey: "directHostOrigin")
        defer {
            try? CredentialStore.delete()
            UserDefaults.standard.removeObject(forKey: "directHostOrigin")
        }
        let model = ConnectionModel()
        model.origin = "https://different.invalid"
        await model.connect()
        XCTAssertFalse(model.connected)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.error, "Enter a new host bearer when changing the saved host address.")
        XCTAssertEqual(try CredentialStore.read(), "synthetic-host-token")
        model.forget()
        XCTAssertNil(try CredentialStore.read())
        XCTAssertNil(UserDefaults.standard.string(forKey: "directHostOrigin"))
        XCTAssertTrue(model.origin.isEmpty)
    }
}
