import Foundation

@main
struct IOSAttestationSmoke {
  static func main() throws {
    guard CommandLine.arguments.count == 2 else {
      throw NSError(domain: "IOSAttestationSmoke", code: 1)
    }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let pem = try Data(contentsOf: url)
    _ = try YubicoPivAttestation.loadAuthorities(pem: pem)

    // The exact certificate allowlist is part of the release boundary. A
    // one-byte mutation must fail before any device certificate is trusted.
    let bodyMarker = Data("\nMI".utf8)
    guard let range = pem.range(of: bodyMarker) else {
      throw NSError(domain: "IOSAttestationSmoke", code: 2)
    }
    var changed = pem
    changed[range.lowerBound + 1] = UInt8(ascii: "N")
    do {
      _ = try YubicoPivAttestation.loadAuthorities(pem: changed)
      throw NSError(domain: "IOSAttestationSmoke", code: 3)
    } catch is YubicoPivAttestation.VerificationError {
      // Expected.
    }
  }
}
