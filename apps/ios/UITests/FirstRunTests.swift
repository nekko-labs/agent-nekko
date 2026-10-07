import XCTest

final class FirstRunTests: XCTestCase {
    func testConnectionControlsAndInvalidInput() {
        let app = XCUIApplication()
        app.launch()
        let connect = app.buttons["Connect and save host access"]
        XCTAssertTrue(connect.waitForExistence(timeout: 10))
        if !connect.isHittable { app.swipeUp() }
        XCTAssertTrue(connect.isHittable)
        connect.tap()
        let error = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Error:")).firstMatch
        if !error.isHittable { app.swipeUp() }
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        let forget = app.buttons["Forget saved host access"]
        if !forget.isHittable { app.swipeUp() }
        forget.tap()
        XCTAssertFalse(error.exists)
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "Native first-run controls"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
