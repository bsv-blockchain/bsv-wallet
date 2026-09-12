import CryptoKit
import Foundation
import Security

/** Offline-only verifier for Yubico PIV manufacturer attestation.
 *
 * Certificate paths and signatures are evaluated directly over the exact,
 * fingerprint-pinned production certificates in the bundled Yubico
 * publication. Neither the system trust store nor network fetching is involved.
 * Direct signature verification also supports genuine legacy F9 certificates
 * that predate correct CA basic constraints but are still valid slot signers.
 */
enum YubicoPivAttestation {
  private static let serialOID = "1.3.6.1.4.1.41482.3.7"
  private static let policyOID = "1.3.6.1.4.1.41482.3.8"
  private static let vaultSubjectCN = "YubiKey PIV Attestation 82"

  private static let legacyRootFingerprints: Set<String> = [
    "7e996a28e3055223733c9aec897900eda9b746e3e15d419556ac6a1179879a50",
    "63ece914e54dd87915f34033c85af4c0696ba1512f8add66ced738331207b546",
    "0fa1386f80eb8713263ae5c1d84deb455bdf08aea50ab05503cefee82b092d42"
  ]
  private static let currentRootFingerprint =
    "62760c6a6ef91679f454c8902b80fd009825b3f25da90f1fbace2ec6586cd5a8"
  private static let branchIntermediateFingerprints: Set<String> = [
    "4698a1d3389c3ec60016c216250f1d0439922832d65142327436376dc2942b55",
    "d4cc3f456fdaf4e7812a21aab1dfe9d8e27d24e2fd2d6f21c9940109f0daa754"
  ]
  private static let pivIntermediateFingerprints: Set<String> = [
    "6de693f05376f5d8ca29069261e1c8626c75d503bd2edbfd75354cad1f722870",
    "2d55b7998f4e42569d6d8fa382b6dc77d1dacf07358b19701163892922b17052",
    "0c90b7d184a36edf50a35f9be935f0c5689bfdcfe5bdd073366cafb49061a440"
  ]
  private static let allFingerprints = legacyRootFingerprints
    .union([currentRootFingerprint])
    .union(branchIntermediateFingerprints)
    .union(pivIntermediateFingerprints)

  struct Authorities {
    let legacyRoots: [SecCertificate]
    let currentRoot: SecCertificate
    let branchIntermediates: [SecCertificate]
    let pivIntermediates: [SecCertificate]
  }

  enum VerificationError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
      switch self { case .invalid(let detail): return detail }
    }
  }

  private final class BundleAnchor: NSObject {}

  static func loadBundledAuthorities() throws -> Authorities {
    let hosts = [Bundle(for: BundleAnchor.self), Bundle.main]
    let resourceBundle = hosts.lazy.compactMap { host -> Bundle? in
      guard let url = host.url(forResource: "YubiKeyPivAttestation", withExtension: "bundle") else {
        return nil
      }
      return Bundle(url: url)
    }.first
    guard let bundle = resourceBundle,
          let url = bundle.url(forResource: "yubico-vault-attestation", withExtension: "pem") else {
      throw VerificationError.invalid("pinned Yubico CA bundle is missing")
    }
    return try loadAuthorities(pem: Data(contentsOf: url))
  }

  static func loadAuthorities(pem: Data) throws -> Authorities {
    let ders = try decodeStrictPEMBundle(pem)
    var byFingerprint: [String: SecCertificate] = [:]
    for der in ders {
      _ = try parseCertificateDER(der)
      guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
        throw VerificationError.invalid("invalid pinned X.509 certificate")
      }
      let digest = fingerprint(der)
      guard byFingerprint[digest] == nil else {
        throw VerificationError.invalid("duplicate pinned X.509 certificate")
      }
      byFingerprint[digest] = certificate
    }
    guard ders.count == allFingerprints.count, Set(byFingerprint.keys) == allFingerprints else {
      throw VerificationError.invalid("pinned Yubico CA bundle does not match its allowlist")
    }
    let legacyRoots = try legacyRootFingerprints.map {
      guard let cert = byFingerprint[$0] else { throw VerificationError.invalid("missing pinned root") }
      return cert
    }
    guard let currentRoot = byFingerprint[currentRootFingerprint] else {
      throw VerificationError.invalid("missing pinned current root")
    }
    let branchIntermediates = try branchIntermediateFingerprints.map {
      guard let cert = byFingerprint[$0] else { throw VerificationError.invalid("missing pinned branch intermediate") }
      return cert
    }
    let pivIntermediates = try pivIntermediateFingerprints.map {
      guard let cert = byFingerprint[$0] else { throw VerificationError.invalid("missing pinned PIV intermediate") }
      return cert
    }
    let authorities = Authorities(
      legacyRoots: legacyRoots,
      currentRoot: currentRoot,
      branchIntermediates: branchIntermediates,
      pivIntermediates: pivIntermediates
    )
    try validatePinnedGraph(authorities)
    return authorities
  }

  static func verifyFactoryCertificate(
    _ f9: SecCertificate,
    expectedSerial: String,
    authorities: Authorities
  ) throws {
    let der = SecCertificateCopyData(f9) as Data
    let parsed = try parseCertificateDER(der)
    try requireKnownCriticalExtensions(parsed)
    guard try serial(from: parsed) == expectedSerial else {
      throw VerificationError.invalid("factory attestation serial mismatch")
    }
    let now = Date()
    try requireValid(parsed, at: now)
    for root in authorities.legacyRoots {
      if try issuedBy(parsed, root, parseCertificate(root), at: now) { return }
    }
    for piv in authorities.pivIntermediates {
      let pivParsed = try parseCertificate(piv)
      guard try issuedBy(parsed, piv, pivParsed, at: now) else { continue }
      for branch in authorities.branchIntermediates {
        let branchParsed = try parseCertificate(branch)
        guard try issuedBy(pivParsed, branch, branchParsed, at: now) else { continue }
        let rootParsed = try parseCertificate(authorities.currentRoot)
        guard try issuedBy(branchParsed, authorities.currentRoot, rootParsed, at: now) else {
          continue
        }
        return
      }
    }
    throw VerificationError.invalid("factory attestation certificate has an unknown issuer")
  }

  static func verifyGeneratedVaultKey(
    _ statement: SecCertificate,
    f9: SecCertificate,
    generatedSec1: Data,
    expectedSerial: String,
    authorities: Authorities
  ) throws {
    try verifyFactoryCertificate(f9, expectedSerial: expectedSerial, authorities: authorities)
    let der = SecCertificateCopyData(statement) as Data
    let parsed = try parseCertificateDER(der)
    try requireKnownCriticalExtensions(parsed)
    guard try serial(from: parsed) == expectedSerial else {
      throw VerificationError.invalid("slot attestation serial mismatch")
    }
    guard parsed.extensions[policyOID] == Data([0x02, 0x03]) else {
      throw VerificationError.invalid("slot attestation does not prove PIN-once and cached-touch policy")
    }
    guard parsed.subjectCommonNames == [vaultSubjectCN] else {
      throw VerificationError.invalid("slot attestation does not identify retired slot 0x82")
    }
    guard let key = SecCertificateCopyKey(statement),
          let attestedSec1 = p256ExternalRepresentation(key),
          attestedSec1 == generatedSec1 else {
      throw VerificationError.invalid("slot attestation public key differs from generated P-256 key")
    }
    let f9Parsed = try parseCertificate(f9)
    guard try issuedBy(parsed, f9, f9Parsed, at: Date(), requireIssuerCA: false) else {
      throw VerificationError.invalid("slot attestation was not signed by the device F9 certificate")
    }
  }

  private static func parseCertificate(_ certificate: SecCertificate) throws -> ParsedCertificate {
    try parseCertificateDER(SecCertificateCopyData(certificate) as Data)
  }

  private static func validatePinnedGraph(_ authorities: Authorities) throws {
    let now = Date()
    let roots = authorities.legacyRoots + [authorities.currentRoot]
    for root in roots {
      let parsed = try parseCertificate(root)
      try requireValid(parsed, at: now)
      guard parsed.subject == parsed.issuer else {
        throw VerificationError.invalid("pinned attestation root is not self-issued")
      }
      try requireCertificateAuthority(parsed)
      try verifySignature(parsed, issuer: root)
    }

    let currentRootParsed = try parseCertificate(authorities.currentRoot)
    for branch in authorities.branchIntermediates {
      let parsed = try parseCertificate(branch)
      guard try issuedBy(parsed, authorities.currentRoot, currentRootParsed, at: now) else {
        throw VerificationError.invalid("invalid pinned attestation branch")
      }
    }
    for piv in authorities.pivIntermediates {
      let parsed = try parseCertificate(piv)
      var valid = false
      for branch in authorities.branchIntermediates {
        if try issuedBy(parsed, branch, parseCertificate(branch), at: now) {
          valid = true
          break
        }
      }
      guard valid else { throw VerificationError.invalid("invalid pinned PIV intermediate") }
    }
  }

  private static func issuedBy(
    _ childParsed: ParsedCertificate,
    _ issuer: SecCertificate,
    _ issuerParsed: ParsedCertificate,
    at now: Date,
    requireIssuerCA: Bool = true
  ) throws -> Bool {
    guard childParsed.issuer == issuerParsed.subject else { return false }
    try requireValid(childParsed, at: now)
    try requireValid(issuerParsed, at: now)
    if requireIssuerCA { try requireCertificateAuthority(issuerParsed) }
    try verifySignature(childParsed, issuer: issuer)
    return true
  }

  private static func requireValid(_ certificate: ParsedCertificate, at now: Date) throws {
    guard certificate.notBefore <= now, now <= certificate.notAfter else {
      throw VerificationError.invalid("attestation certificate is outside its validity period")
    }
  }

  private static func requireCertificateAuthority(_ certificate: ParsedCertificate) throws {
    guard let encoded = certificate.extensions["2.5.29.19"] else {
      throw VerificationError.invalid("attestation issuer has no basic constraints")
    }
    var outer = DERReader(encoded)
    var sequence = try outer.read(0x30).reader()
    try outer.requireFinished()
    guard !sequence.finished, try sequence.peekTag() == 0x01,
          try sequence.read(0x01).bytes == Data([0xff]) else {
      throw VerificationError.invalid("attestation issuer is not a certificate authority")
    }
    if !sequence.finished {
      try requirePositiveInteger(try sequence.read(0x02).bytes)
    }
    try sequence.requireFinished()

    if let encodedUsage = certificate.extensions["2.5.29.15"] {
      var usage = DERReader(encodedUsage)
      let bits = try usage.read(0x03).bytes
      try usage.requireFinished()
      guard let unusedByte = bits.first, unusedByte <= 7 else {
        throw VerificationError.invalid("invalid certificate key-usage BIT STRING")
      }
      let unused = Int(unusedByte)
      guard bits.count > 1 else {
        throw VerificationError.invalid("attestation issuer cannot sign certificates")
      }
      if unused > 0 {
        let mask = UInt8((1 << unused) - 1)
        guard bits.last! & mask == 0 else {
          throw VerificationError.invalid("non-canonical certificate key-usage BIT STRING")
        }
      }
      guard bits[bits.index(after: bits.startIndex)] & 0x04 != 0 else {
        throw VerificationError.invalid("attestation issuer cannot sign certificates")
      }
    }
  }

  private static func verifySignature(_ certificate: ParsedCertificate, issuer: SecCertificate) throws {
    guard let key = SecCertificateCopyKey(issuer) else {
      throw VerificationError.invalid("attestation issuer has no public key")
    }
    let algorithm: SecKeyAlgorithm
    switch certificate.signatureAlgorithmOID {
    case "1.2.840.113549.1.1.11": algorithm = .rsaSignatureMessagePKCS1v15SHA256
    case "1.2.840.113549.1.1.12": algorithm = .rsaSignatureMessagePKCS1v15SHA384
    case "1.2.840.113549.1.1.13": algorithm = .rsaSignatureMessagePKCS1v15SHA512
    case "1.2.840.10045.4.3.2": algorithm = .ecdsaSignatureMessageX962SHA256
    case "1.2.840.10045.4.3.3": algorithm = .ecdsaSignatureMessageX962SHA384
    case "1.2.840.10045.4.3.4": algorithm = .ecdsaSignatureMessageX962SHA512
    default: throw VerificationError.invalid("unsupported attestation signature algorithm")
    }
    guard SecKeyIsAlgorithmSupported(key, .verify, algorithm) else {
      throw VerificationError.invalid("attestation signature algorithm does not match issuer key")
    }
    var error: Unmanaged<CFError>?
    guard SecKeyVerifySignature(
      key,
      algorithm,
      certificate.tbsCertificate as CFData,
      certificate.signature as CFData,
      &error
    ) else {
      throw VerificationError.invalid("attestation certificate signature is invalid")
    }
  }

  private static func requireKnownCriticalExtensions(_ parsed: ParsedCertificate) throws {
    let allowed: Set<String> = [
      "2.5.29.14", "2.5.29.15", "2.5.29.19", "2.5.29.35",
      "1.3.6.1.4.1.41482.3.3", serialOID, policyOID,
      "1.3.6.1.4.1.41482.3.9", "1.3.6.1.4.1.41482.3.10",
      "1.3.6.1.4.1.41482.3.11"
    ]
    guard parsed.criticalExtensions.isSubset(of: allowed) else {
      throw VerificationError.invalid("attestation certificate has an unsupported critical extension")
    }
  }

  private static func serial(from parsed: ParsedCertificate) throws -> String {
    guard let encoded = parsed.extensions[serialOID] else {
      throw VerificationError.invalid("attestation certificate has no device serial")
    }
    var reader = DERReader(encoded)
    let integer = try reader.read(0x02).bytes
    try reader.requireFinished()
    try requirePositiveInteger(integer)
    let unsigned = integer.first == 0 ? integer.dropFirst() : integer[...]
    guard unsigned.count <= 4 else {
      throw VerificationError.invalid("attestation device serial is out of range")
    }
    var result: UInt64 = 0
    for byte in unsigned { result = (result << 8) | UInt64(byte) }
    return String(result)
  }

  private static func p256ExternalRepresentation(_ key: SecKey) -> Data? {
    guard let attributes = SecKeyCopyAttributes(key) as? [CFString: Any],
          (attributes[kSecAttrKeyType] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String),
          (attributes[kSecAttrKeySizeInBits] as? Int) == 256 else { return nil }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(key, &error) as Data?,
          data.count == 65, data.first == 0x04 else { return nil }
    return data
  }

  private static func fingerprint(_ der: Data) -> String {
    SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
  }

  struct ParsedCertificate {
    let tbsCertificate: Data
    let signatureAlgorithmOID: String
    let signature: Data
    let issuer: Data
    let subject: Data
    let notBefore: Date
    let notAfter: Date
    let extensions: [String: Data]
    let criticalExtensions: Set<String>
    let subjectCommonNames: [String]
  }

  /** Canonical DER parser for the security-relevant certificate structure.
   * Security.framework is used only to extract public keys and perform the
   * explicitly selected signature primitive. */
  static func parseCertificateDER(_ der: Data) throws -> ParsedCertificate {
    var root = DERReader(der)
    let certificate = try root.read(0x30)
    try root.requireFinished()
    var cert = certificate.reader()
    let tbs = try cert.read(0x30)
    let outerSignatureAlgorithm = try cert.read(0x30)
    let signatureBits = try cert.read(0x03).bytes
    guard signatureBits.count > 1, signatureBits.first == 0 else {
      throw VerificationError.invalid("invalid certificate signature BIT STRING")
    }
    try cert.requireFinished()

    var body = tbs.reader()
    guard try body.peekTag() == 0xa0 else {
      throw VerificationError.invalid("attestation certificate is not X.509 v3")
    }
    var version = try body.read(0xa0).reader()
    guard try version.read(0x02).bytes == Data([0x02]) else {
      throw VerificationError.invalid("attestation certificate is not X.509 v3")
    }
    try version.requireFinished()
    try requirePositiveInteger(try body.read(0x02).bytes)
    let innerSignatureAlgorithm = try body.read(0x30)
    guard innerSignatureAlgorithm.encoded == outerSignatureAlgorithm.encoded else {
      throw VerificationError.invalid("certificate signature algorithms differ")
    }
    let signatureAlgorithmOID = try parseSignatureAlgorithm(outerSignatureAlgorithm)
    let issuer = try body.read(0x30)
    let validity = try parseValidity(try body.read(0x30))
    let subject = try body.read(0x30)
    _ = try body.read(0x30) // subjectPublicKeyInfo

    var extensions: [String: Data]?
    var critical = Set<String>()
    while !body.finished {
      switch try body.peekTag() {
      case 0x81, 0x82:
        _ = try body.read(try body.peekTag())
      case 0xa3:
        guard extensions == nil else {
          throw VerificationError.invalid("duplicate certificate extensions field")
        }
        var explicit = try body.read(0xa3).reader()
        let parsed = try parseExtensions(try explicit.read(0x30))
        try explicit.requireFinished()
        extensions = parsed.values
        critical = parsed.critical
      default:
        throw VerificationError.invalid("unexpected TBSCertificate field")
      }
    }
    return ParsedCertificate(
      tbsCertificate: tbs.encoded,
      signatureAlgorithmOID: signatureAlgorithmOID,
      signature: signatureBits.dropFirst(),
      issuer: issuer.encoded,
      subject: subject.encoded,
      notBefore: validity.notBefore,
      notAfter: validity.notAfter,
      extensions: extensions ?? [:],
      criticalExtensions: critical,
      subjectCommonNames: try parseCommonNames(subject)
    )
  }

  private static func parseSignatureAlgorithm(_ value: DERValue) throws -> String {
    var reader = value.reader()
    let oid = try decodeOID(try reader.read(0x06).bytes)
    switch oid {
    case "1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13":
      // Yubico's B2 production intermediate uses the standards-compatible
      // absent form; the other pinned RSA certificates encode explicit NULL.
      if !reader.finished {
        guard try reader.read(0x05).bytes.isEmpty else {
          throw VerificationError.invalid("invalid RSA signature parameters")
        }
      }
    case "1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4":
      break
    default:
      throw VerificationError.invalid("unsupported attestation signature algorithm")
    }
    try reader.requireFinished()
    return oid
  }

  private static func parseValidity(_ value: DERValue) throws -> (notBefore: Date, notAfter: Date) {
    var reader = value.reader()
    let notBefore = try parseTime(try reader.readAny())
    let notAfter = try parseTime(try reader.readAny())
    try reader.requireFinished()
    guard notBefore <= notAfter else {
      throw VerificationError.invalid("certificate validity interval is inverted")
    }
    return (notBefore, notAfter)
  }

  private static func parseTime(_ value: DERValue) throws -> Date {
    guard let string = String(data: value.bytes, encoding: .ascii),
          Data(string.utf8) == value.bytes, string.last == "Z" else {
      throw VerificationError.invalid("invalid certificate time")
    }
    let digits = string.dropLast()
    let yearDigits: Int
    switch value.tag {
    case 0x17 where digits.count == 12: yearDigits = 2
    case 0x18 where digits.count == 14: yearDigits = 4
    default: throw VerificationError.invalid("non-canonical certificate time")
    }
    guard digits.allSatisfy({ $0.isASCII && $0.isNumber }) else {
      throw VerificationError.invalid("invalid certificate time digits")
    }
    func number(_ start: Int, _ length: Int) -> Int? {
      let lower = digits.index(digits.startIndex, offsetBy: start)
      let upper = digits.index(lower, offsetBy: length)
      return Int(digits[lower..<upper])
    }
    guard let encodedYear = number(0, yearDigits),
          let month = number(yearDigits, 2),
          let day = number(yearDigits + 2, 2),
          let hour = number(yearDigits + 4, 2),
          let minute = number(yearDigits + 6, 2),
          let second = number(yearDigits + 8, 2) else {
      throw VerificationError.invalid("invalid certificate time components")
    }
    let year = yearDigits == 2 ? (encodedYear >= 50 ? 1900 + encodedYear : 2000 + encodedYear) : encodedYear
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let expected = DateComponents(
      calendar: calendar,
      timeZone: calendar.timeZone,
      year: year,
      month: month,
      day: day,
      hour: hour,
      minute: minute,
      second: second
    )
    guard let date = calendar.date(from: expected) else {
      throw VerificationError.invalid("invalid certificate time components")
    }
    let actual = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    guard actual.year == year, actual.month == month, actual.day == day,
          actual.hour == hour, actual.minute == minute, actual.second == second else {
      throw VerificationError.invalid("invalid certificate time components")
    }
    return date
  }

  private static func parseExtensions(
    _ sequence: DERValue
  ) throws -> (values: [String: Data], critical: Set<String>) {
    var values: [String: Data] = [:]
    var critical = Set<String>()
    var reader = sequence.reader()
    while !reader.finished {
      var extensionReader = try reader.read(0x30).reader()
      let oid = try decodeOID(try extensionReader.read(0x06).bytes)
      if !extensionReader.finished, try extensionReader.peekTag() == 0x01 {
        guard try extensionReader.read(0x01).bytes == Data([0xff]) else {
          throw VerificationError.invalid("non-canonical DER BOOLEAN")
        }
        critical.insert(oid)
      }
      let value = try extensionReader.read(0x04).bytes
      try extensionReader.requireFinished()
      guard values.updateValue(value, forKey: oid) == nil else {
        throw VerificationError.invalid("duplicate certificate extension \(oid)")
      }
    }
    return (values, critical)
  }

  private static func parseCommonNames(_ subject: DERValue) throws -> [String] {
    var result: [String] = []
    var rdns = subject.reader()
    while !rdns.finished {
      var set = try rdns.read(0x31).reader()
      while !set.finished {
        var atv = try set.read(0x30).reader()
        let oid = try decodeOID(try atv.read(0x06).bytes)
        let value = try atv.readAny()
        try atv.requireFinished()
        if oid == "2.5.4.3" { result.append(try decodeDirectoryString(value)) }
      }
    }
    return result
  }

  private static func decodeDirectoryString(_ value: DERValue) throws -> String {
    switch value.tag {
    case 0x0c:
      guard let string = String(data: value.bytes, encoding: .utf8),
            Data(string.utf8) == value.bytes else {
        throw VerificationError.invalid("invalid UTF-8 directory string")
      }
      return string
    case 0x13, 0x16:
      guard value.bytes.allSatisfy({ (0x20...0x7e).contains($0) }),
            let string = String(data: value.bytes, encoding: .ascii) else {
        throw VerificationError.invalid("invalid ASCII directory string")
      }
      return string
    default:
      throw VerificationError.invalid("unsupported common-name string encoding")
    }
  }

  private static func requirePositiveInteger(_ bytes: Data) throws {
    guard let first = bytes.first else { throw VerificationError.invalid("empty DER INTEGER") }
    guard first & 0x80 == 0 else { throw VerificationError.invalid("negative DER INTEGER") }
    if bytes.count > 1, first == 0, bytes[bytes.index(after: bytes.startIndex)] & 0x80 == 0 {
      throw VerificationError.invalid("non-minimal DER INTEGER")
    }
  }

  private static func decodeOID(_ data: Data) throws -> String {
    let bytes = [UInt8](data)
    guard !bytes.isEmpty else { throw VerificationError.invalid("empty DER OID") }
    var index = 0
    func component() throws -> UInt64 {
      guard index < bytes.count, bytes[index] != 0x80 else {
        throw VerificationError.invalid("non-canonical DER OID")
      }
      var value: UInt64 = 0
      while true {
        guard index < bytes.count else { throw VerificationError.invalid("truncated DER OID") }
        let byte = bytes[index]
        index += 1
        guard value <= UInt64.max >> 7 else {
          throw VerificationError.invalid("DER OID component overflow")
        }
        value = (value << 7) | UInt64(byte & 0x7f)
        if byte & 0x80 == 0 { return value }
      }
    }
    let first = try component()
    var values: [UInt64]
    if first < 40 { values = [0, first] }
    else if first < 80 { values = [1, first - 40] }
    else { values = [2, first - 80] }
    while index < bytes.count { values.append(try component()) }
    return values.map(String.init).joined(separator: ".")
  }

  struct DERValue {
    let tag: UInt8
    let bytes: Data
    let encoded: Data
    func reader() -> DERReader { DERReader(bytes) }
  }

  struct DERReader {
    private let source: [UInt8]
    private var offset = 0
    var finished: Bool { offset == source.count }

    init(_ data: Data) { source = [UInt8](data) }

    func peekTag() throws -> UInt8 {
      guard offset < source.count else { throw VerificationError.invalid("truncated DER value") }
      return source[offset]
    }

    mutating func requireFinished() throws {
      guard finished else { throw VerificationError.invalid("trailing DER data") }
    }

    mutating func read(_ expectedTag: UInt8) throws -> DERValue {
      let value = try readAny()
      guard value.tag == expectedTag else {
        throw VerificationError.invalid("unexpected DER tag")
      }
      return value
    }

    mutating func readAny() throws -> DERValue {
      guard offset < source.count else { throw VerificationError.invalid("truncated DER tag") }
      let start = offset
      let tag = source[offset]
      offset += 1
      guard tag & 0x1f != 0x1f else {
        throw VerificationError.invalid("high-tag-number DER is not accepted")
      }
      guard offset < source.count else { throw VerificationError.invalid("truncated DER length") }
      let first = source[offset]
      offset += 1
      let length: Int
      if first & 0x80 == 0 {
        length = Int(first)
      } else {
        let count = Int(first & 0x7f)
        guard (1...4).contains(count), offset + count <= source.count,
              source[offset] != 0 else {
          throw VerificationError.invalid("invalid DER length")
        }
        var parsed: UInt64 = 0
        for _ in 0..<count {
          parsed = (parsed << 8) | UInt64(source[offset])
          offset += 1
        }
        guard parsed >= 128, parsed <= UInt64(Int.max) else {
          throw VerificationError.invalid("non-canonical DER length")
        }
        length = Int(parsed)
      }
      guard length <= source.count - offset else {
        throw VerificationError.invalid("truncated DER content")
      }
      let bytes = Data(source[offset..<(offset + length)])
      offset += length
      return DERValue(tag: tag, bytes: bytes, encoded: Data(source[start..<offset]))
    }
  }

  private static func decodeStrictPEMBundle(_ pem: Data) throws -> [Data] {
    guard let string = String(data: pem, encoding: .ascii) else {
      throw VerificationError.invalid("pinned CA bundle is not ASCII PEM")
    }
    let begin = "-----BEGIN CERTIFICATE-----"
    let end = "-----END CERTIFICATE-----"
    var remainder = string[...]
    var certificates: [Data] = []
    while true {
      while let first = remainder.first, first.isWhitespace { remainder.removeFirst() }
      if remainder.isEmpty { break }
      guard remainder.hasPrefix(begin) else {
        throw VerificationError.invalid("unexpected data in pinned CA bundle")
      }
      remainder.removeFirst(begin.count)
      guard let endRange = remainder.range(of: end) else {
        throw VerificationError.invalid("unterminated certificate in pinned CA bundle")
      }
      let body = remainder[..<endRange.lowerBound].filter { !$0.isWhitespace }
      guard !body.isEmpty, body.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=") }),
            let der = Data(base64Encoded: String(body), options: []) else {
        throw VerificationError.invalid("invalid base64 in pinned CA bundle")
      }
      certificates.append(der)
      remainder = remainder[endRange.upperBound...]
    }
    guard !certificates.isEmpty else {
      throw VerificationError.invalid("pinned CA bundle is empty")
    }
    return certificates
  }
}
