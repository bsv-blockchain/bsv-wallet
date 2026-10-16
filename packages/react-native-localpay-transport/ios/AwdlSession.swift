import Darwin
import Foundation
import Network
import os.log
import Security

private let awdlLog = OSLog(subsystem: "org.bsvblockchain.wallet", category: "LocalPayAwdl")

enum AwdlSession {
  static let serviceType = "_bsvpay._tcp"

  /// Whether the Wi-Fi radio is up enough for AWDL to carry a connection.
  ///
  /// iOS has no public API (and no entitlement) for "is the Wi-Fi radio on".
  /// The nearest observable fact is the `awdl0` interface: iOS takes it down
  /// when Wi-Fi is switched off in Settings and keeps it up while Wi-Fi is on,
  /// joined to a network or not. Undocumented, so it fails OPEN: no `awdl0`
  /// entry at all (renamed or hidden by a future iOS) reports true and leaves
  /// the old behaviour — try AWDL, fall to the QR fountain on failure. Only an
  /// interface that exists and is not IFF_UP reports false, which is what lets
  /// a payee stop minting CAP_AWDL and a payer skip a send that would wait out
  /// SEND_TIMEOUT_MS before the fountain.
  static func radioUp() -> Bool {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return true }
    defer { freeifaddrs(head) }
    var found = false
    var up = false
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let entry = cursor {
      if String(cString: entry.pointee.ifa_name) == "awdl0" {
        found = true
        if (entry.pointee.ifa_flags & UInt32(IFF_UP)) != 0 { up = true }
      }
      cursor = entry.pointee.ifa_next
    }
    os_log("awdl0 found=%d up=%d", log: awdlLog, type: .default, found ? 1 : 0, up ? 1 : 0)
    return !found || up
  }

  /// TCP over AWDL, authenticated and encrypted with a pre-shared key.
  /// Only a peer that saw the pairing QR holds the PSK, so this is mutual auth.
  static func parameters(psk: Data, identity: Data) -> NWParameters {
    let tls = NWProtocolTLS.Options()
    let opts = tls.securityProtocolOptions
    psk.withUnsafeBytes { pskBuf in
      identity.withUnsafeBytes { idBuf in
        let pskData = DispatchData(bytes: pskBuf)
        let idData = DispatchData(bytes: idBuf)
        sec_protocol_options_add_pre_shared_key(
          opts,
          pskData as __DispatchData,
          idData as __DispatchData
        )
      }
    }
    sec_protocol_options_append_tls_ciphersuite(
      opts,
      tls_ciphersuite_t(rawValue: TLS_PSK_WITH_AES_128_GCM_SHA256)!
    )
    let params = NWParameters(tls: tls)
    params.includePeerToPeer = true
    return params
  }

  /// 4-byte big-endian length prefix, so a stream yields discrete frames.
  ///
  /// `.bigEndian` is applied on both the write side here and the read side in
  /// `readFrame` below. That is correct, not merely symmetric-looking: on a
  /// little-endian platform (every current Apple device), `UInt32.bigEndian`
  /// byte-swaps the value, and applying that same byte swap a second time on
  /// read undoes it -- i.e. `.bigEndian` is its own inverse there. So
  /// "encode with `.bigEndian`, decode with `.bigEndian`" round-trips the
  /// original value, independent of what the host's native endianness is.
  static func lengthPrefixed(_ payload: Data) -> Data {
    var out = Data(count: 4)
    let n = UInt32(payload.count).bigEndian
    withUnsafeBytes(of: n) { out.replaceSubrange(0..<4, with: $0) }
    out.append(payload)
    return out
  }

  static func readFrame(on conn: NWConnection, completion: @escaping (Result<Data, Error>) -> Void) {
    conn.receive(minimumIncompleteLength: 4, maximumLength: 4) { header, _, _, error in
      if let error { return completion(.failure(error)) }
      guard let header, header.count == 4 else {
        return completion(.failure(NSError(domain: "LocalPayTransport", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "short header"])))
      }
      let length = Int(header.withUnsafeBytes { $0.load(as: UInt32.self).bigEndian })
      guard length > 0, length <= 8 * 1024 * 1024 else {
        return completion(.failure(NSError(domain: "LocalPayTransport", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "frame length out of range: \(length)"])))
      }
      conn.receive(minimumIncompleteLength: length, maximumLength: length) { body, _, _, error in
        if let error { return completion(.failure(error)) }
        guard let body, body.count == length else {
          return completion(.failure(NSError(domain: "LocalPayTransport", code: 3,
            userInfo: [NSLocalizedDescriptionKey: "short body"])))
        }
        completion(.success(body))
      }
    }
  }
}
