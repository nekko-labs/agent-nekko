// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NekkoProtocol",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "NekkoProtocol", targets: ["NekkoProtocol"])],
    targets: [
        .target(name: "NekkoProtocol"),
        .testTarget(name: "NekkoProtocolTests", dependencies: ["NekkoProtocol"])
    ]
)
