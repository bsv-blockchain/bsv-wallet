// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "BsvBridgeQueue",
  platforms: [.iOS(.v15), .macOS(.v13)],
  products: [.library(name: "BsvBridgeQueue", targets: ["BsvBridgeQueue"])],
  targets: [.target(name: "BsvBridgeQueue")]
)
