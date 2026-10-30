// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "BsvBridgeQueue",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [.library(name: "BsvBridgeQueue", targets: ["BsvBridgeQueue"])],
  targets: [
    .target(name: "BsvBridgeQueue"),
    // Spawned by the macOS-only cross-process RaceTests; iOS has no `Process`.
    .executableTarget(name: "bridge-race-helper", dependencies: ["BsvBridgeQueue"]),
    .testTarget(name: "BsvBridgeQueueTests", dependencies: ["BsvBridgeQueue", "bridge-race-helper"])
  ]
)
