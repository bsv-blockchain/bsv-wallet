package com.margelo.nitro.yubikeypiv

import java.io.InputStream
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.MessageDigest
import java.security.PublicKey
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.interfaces.RSAPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.util.Date

/**
 * Offline verifier for Yubico's PIV manufacturer attestation.
 *
 * The bundled certificates and their fingerprints come only from Yubico's
 * production PKI publication. Verification is a closed graph over those exact
 * certificates: Android's system trust store and AIA/network fetching are
 * never consulted. The generated slot statement is verified separately
 * against the device's factory F9 certificate because some genuine legacy F9
 * certificates predate correct CA basic-constraints.
 */
internal object YubicoPivAttestation {
  private const val SERIAL_OID = "1.3.6.1.4.1.41482.3.7"
  private const val POLICY_OID = "1.3.6.1.4.1.41482.3.8"
  private const val VAULT_SUBJECT_CN = "YubiKey PIV Attestation 82"

  private val legacyRootFingerprints = setOf(
    "7e996a28e3055223733c9aec897900eda9b746e3e15d419556ac6a1179879a50",
    "63ece914e54dd87915f34033c85af4c0696ba1512f8add66ced738331207b546",
    "0fa1386f80eb8713263ae5c1d84deb455bdf08aea50ab05503cefee82b092d42"
  )
  private const val currentRootFingerprint =
    "62760c6a6ef91679f454c8902b80fd009825b3f25da90f1fbace2ec6586cd5a8"
  private val branchIntermediateFingerprints = setOf(
    "4698a1d3389c3ec60016c216250f1d0439922832d65142327436376dc2942b55",
    "d4cc3f456fdaf4e7812a21aab1dfe9d8e27d24e2fd2d6f21c9940109f0daa754"
  )
  private val pivIntermediateFingerprints = setOf(
    "6de693f05376f5d8ca29069261e1c8626c75d503bd2edbfd75354cad1f722870",
    "2d55b7998f4e42569d6d8fa382b6dc77d1dacf07358b19701163892922b17052",
    "0c90b7d184a36edf50a35f9be935f0c5689bfdcfe5bdd073366cafb49061a440"
  )
  private val allFingerprints = legacyRootFingerprints + currentRootFingerprint +
    branchIntermediateFingerprints + pivIntermediateFingerprints

  internal data class Authorities(
    val legacyRoots: List<X509Certificate>,
    val currentRoot: X509Certificate,
    val branchIntermediates: List<X509Certificate>,
    val pivIntermediates: List<X509Certificate>
  )

  internal fun loadAuthorities(input: InputStream): Authorities {
    val certs = input.use {
      CertificateFactory.getInstance("X.509").generateCertificates(it)
        .map { certificate -> certificate as X509Certificate }
    }
    val byFingerprint = certs.associateBy(::fingerprint)
    require(certs.size == allFingerprints.size && byFingerprint.keys == allFingerprints) {
      "pinned Yubico CA bundle does not match its certificate allowlist"
    }
    certs.forEach { parseCertificateDer(it.encoded) }

    val authorities = Authorities(
      legacyRoots = legacyRootFingerprints.map { byFingerprint.getValue(it) },
      currentRoot = byFingerprint.getValue(currentRootFingerprint),
      branchIntermediates = branchIntermediateFingerprints.map { byFingerprint.getValue(it) },
      pivIntermediates = pivIntermediateFingerprints.map { byFingerprint.getValue(it) }
    )
    validatePinnedGraph(authorities)
    return authorities
  }

  /** Validate the immutable factory F9 certificate before any PIV credential
   * is changed. Missing serials and every unknown/preview chain fail closed. */
  internal fun verifyFactoryCertificate(
    f9: X509Certificate,
    expectedSerial: String,
    authorities: Authorities,
    now: Date = Date()
  ) {
    val parsed = parseCertificateDer(f9.encoded)
    requireKnownCriticalExtensions(f9)
    require(serialFrom(parsed) == expectedSerial) { "factory attestation serial mismatch" }
    f9.checkValidity(now)

    if (authorities.legacyRoots.any { issuedBy(f9, it, now) }) return

    val pivIssuer = authorities.pivIntermediates.singleOrNull { issuedBy(f9, it, now) }
      ?: throw IllegalArgumentException("factory attestation certificate has an unknown issuer")
    val branchIssuer = authorities.branchIntermediates.singleOrNull { issuedBy(pivIssuer, it, now) }
      ?: throw IllegalArgumentException("PIV attestation intermediate has an unknown issuer")
    require(issuedBy(branchIssuer, authorities.currentRoot, now)) {
      "attestation branch does not chain to the pinned Yubico root"
    }
  }

  /** Verify the freshly generated retired-slot key and its attestation in the
   * same native PIV session, before JS may receive an enrollment public key. */
  internal fun verifyGeneratedVaultKey(
    statement: X509Certificate,
    f9: X509Certificate,
    generatedSec1: ByteArray,
    expectedSerial: String,
    authorities: Authorities,
    now: Date = Date()
  ) {
    verifyFactoryCertificate(f9, expectedSerial, authorities, now)
    val parsed = parseCertificateDer(statement.encoded)
    requireKnownCriticalExtensions(statement)
    statement.checkValidity(now)
    require(statement.issuerX500Principal == f9.subjectX500Principal) {
      "slot attestation issuer does not match the device F9 certificate"
    }
    statement.verify(f9.publicKey)
    require(serialFrom(parsed) == expectedSerial) { "slot attestation serial mismatch" }
    require(parsed.extensions[POLICY_OID]?.contentEquals(byteArrayOf(0x02, 0x03)) == true) {
      "slot attestation does not prove PIN-once and cached-touch policy"
    }
    require(parsed.subjectCommonNames == listOf(VAULT_SUBJECT_CN)) {
      "slot attestation does not identify retired slot 0x82"
    }
    val attestedSec1 = p256Sec1(statement.publicKey)
    require(attestedSec1.contentEquals(generatedSec1)) {
      "slot attestation public key differs from generated key"
    }
  }

  private fun validatePinnedGraph(authorities: Authorities) {
    val now = Date()
    (authorities.legacyRoots + authorities.currentRoot).forEach { root ->
      root.checkValidity(now)
      require(root.subjectX500Principal == root.issuerX500Principal) { "pinned root is not self-issued" }
      root.verify(root.publicKey)
    }
    authorities.branchIntermediates.forEach { branch ->
      require(issuedBy(branch, authorities.currentRoot, now)) { "invalid pinned attestation branch" }
    }
    authorities.pivIntermediates.forEach { piv ->
      require(authorities.branchIntermediates.any { issuedBy(piv, it, now) }) {
        "invalid pinned PIV intermediate"
      }
    }
  }

  private fun issuedBy(child: X509Certificate, issuer: X509Certificate, now: Date): Boolean {
    if (child.issuerX500Principal != issuer.subjectX500Principal) return false
    return try {
      child.checkValidity(now)
      issuer.checkValidity(now)
      requireCertificateAuthority(issuer)
      child.verify(issuer.publicKey)
      true
    } catch (_: Throwable) {
      false
    }
  }

  private fun requireCertificateAuthority(cert: X509Certificate) {
    require(cert.basicConstraints >= 0) { "issuer is not a CA" }
    cert.keyUsage?.let { usage ->
      require(usage.size > 5 && usage[5]) { "issuer cannot sign certificates" }
    }
  }

  private fun requireKnownCriticalExtensions(cert: X509Certificate) {
    val allowed = setOf(
      "2.5.29.14", // subject key identifier
      "2.5.29.15", // key usage
      "2.5.29.19", // basic constraints
      "2.5.29.35", // authority key identifier
      "1.3.6.1.4.1.41482.3.3", // firmware
      SERIAL_OID,
      POLICY_OID,
      "1.3.6.1.4.1.41482.3.9", // form factor
      "1.3.6.1.4.1.41482.3.10", // FIPS
      "1.3.6.1.4.1.41482.3.11" // CSPN
    )
    require(cert.criticalExtensionOIDs.orEmpty().all(allowed::contains)) {
      "attestation certificate has an unsupported critical extension"
    }
  }

  private fun serialFrom(parsed: ParsedCertificate): String {
    val encoded = parsed.extensions[SERIAL_OID]
      ?: throw IllegalArgumentException("attestation certificate has no device serial")
    val reader = DerReader(encoded)
    val integer = reader.read(0x02)
    reader.requireFinished()
    val bytes = integer.bytes()
    requirePositiveInteger(bytes)
    val unsigned = if (bytes.size > 1 && bytes[0] == 0.toByte()) {
      bytes.copyOfRange(1, bytes.size)
    } else {
      bytes
    }
    require(unsigned.size <= 4) { "attestation device serial is out of range" }
    return BigInteger(bytes).toString()
  }

  private fun p256Sec1(key: PublicKey): ByteArray {
    val ec = key as? ECPublicKey ?: throw IllegalArgumentException("attested key is not EC")
    val expected = AlgorithmParameters.getInstance("EC").run {
      init(ECGenParameterSpec("secp256r1"))
      getParameterSpec(ECParameterSpec::class.java)
    }
    require(sameCurve(ec.params, expected)) { "attested EC key is not P-256" }
    val x = fixedUnsigned(ec.w.affineX, 32)
    val y = fixedUnsigned(ec.w.affineY, 32)
    return byteArrayOf(0x04) + x + y
  }

  private fun sameCurve(a: ECParameterSpec, b: ECParameterSpec): Boolean {
    val af = a.curve.field as? ECFieldFp ?: return false
    val bf = b.curve.field as? ECFieldFp ?: return false
    return af.p == bf.p && a.curve.a == b.curve.a && a.curve.b == b.curve.b &&
      a.generator == b.generator && a.order == b.order && a.cofactor == b.cofactor
  }

  private fun fixedUnsigned(value: BigInteger, size: Int): ByteArray {
    require(value.signum() >= 0)
    val encoded = value.toByteArray()
    val unsigned = if (encoded.size > 1 && encoded[0] == 0.toByte()) encoded.copyOfRange(1, encoded.size) else encoded
    require(unsigned.size <= size)
    return ByteArray(size - unsigned.size) + unsigned
  }

  private fun fingerprint(cert: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }

  internal data class ParsedCertificate(
    val extensions: Map<String, ByteArray>,
    val subjectCommonNames: List<String>
  )

  /** Parse enough of Certificate/TBSCertificate to enforce canonical DER,
   * unique extension OIDs, an exact subject CN, and exact extension payloads.
   * The platform X.509 parser still owns signature/key decoding. */
  internal fun parseCertificateDer(der: ByteArray): ParsedCertificate {
    val root = DerReader(der)
    val certificate = root.read(0x30)
    root.requireFinished()
    val cert = certificate.reader()
    val tbs = cert.read(0x30)
    val outerSignatureAlgorithm = cert.read(0x30)
    val signature = cert.read(0x03).bytes()
    require(signature.isNotEmpty() && signature[0] == 0.toByte()) { "invalid certificate signature BIT STRING" }
    cert.requireFinished()

    val body = tbs.reader()
    if (body.peekTag() == 0xa0) {
      val version = body.read(0xa0).reader()
      val value = version.read(0x02).bytes()
      version.requireFinished()
      require(value.contentEquals(byteArrayOf(0x02))) { "attestation certificate is not X.509 v3" }
    } else {
      throw IllegalArgumentException("attestation certificate is not X.509 v3")
    }
    requirePositiveInteger(body.read(0x02).bytes()) // certificate serial
    val innerSignatureAlgorithm = body.read(0x30)
    require(innerSignatureAlgorithm.bytes().contentEquals(outerSignatureAlgorithm.bytes())) {
      "certificate signature algorithms differ"
    }
    parseSignatureAlgorithm(outerSignatureAlgorithm)
    body.read(0x30) // issuer
    body.read(0x30) // validity
    val subject = body.read(0x30)
    body.read(0x30) // subjectPublicKeyInfo

    var extensionMap: Map<String, ByteArray>? = null
    while (!body.finished()) {
      when (body.peekTag()) {
        0x81, 0x82 -> body.read(body.peekTag()) // issuer/subject unique id
        0xa3 -> {
          require(extensionMap == null) { "duplicate certificate extensions field" }
          val explicit = body.read(0xa3).reader()
          extensionMap = parseExtensions(explicit.read(0x30))
          explicit.requireFinished()
        }
        else -> throw IllegalArgumentException("unexpected TBSCertificate field")
      }
    }
    return ParsedCertificate(extensionMap ?: emptyMap(), parseCommonNames(subject))
  }

  private fun parseSignatureAlgorithm(value: DerValue): String {
    val reader = value.reader()
    val oid = decodeOid(reader.read(0x06).bytes())
    when (oid) {
      "1.2.840.113549.1.1.11",
      "1.2.840.113549.1.1.12",
      "1.2.840.113549.1.1.13" -> {
        // Yubico's B2 production intermediate omits the otherwise usual NULL.
        if (!reader.finished()) require(reader.read(0x05).bytes().isEmpty()) {
          "invalid RSA signature parameters"
        }
      }
      "1.2.840.10045.4.3.2",
      "1.2.840.10045.4.3.3",
      "1.2.840.10045.4.3.4" -> Unit
      else -> throw IllegalArgumentException("unsupported attestation signature algorithm")
    }
    reader.requireFinished()
    return oid
  }

  private fun parseExtensions(sequence: DerValue): Map<String, ByteArray> {
    val extensions = linkedMapOf<String, ByteArray>()
    val reader = sequence.reader()
    while (!reader.finished()) {
      val extension = reader.read(0x30).reader()
      val oid = decodeOid(extension.read(0x06).bytes())
      if (extension.peekTag() == 0x01) {
        val critical = extension.read(0x01).bytes()
        require(critical.contentEquals(byteArrayOf(0xff.toByte()))) { "non-canonical DER BOOLEAN" }
      }
      val value = extension.read(0x04).bytes()
      extension.requireFinished()
      require(extensions.put(oid, value) == null) { "duplicate certificate extension $oid" }
    }
    return extensions
  }

  private fun parseCommonNames(subject: DerValue): List<String> {
    val names = mutableListOf<String>()
    val rdns = subject.reader()
    while (!rdns.finished()) {
      val set = rdns.read(0x31).reader()
      while (!set.finished()) {
        val atv = set.read(0x30).reader()
        val oid = decodeOid(atv.read(0x06).bytes())
        val value = atv.readAny()
        atv.requireFinished()
        if (oid == "2.5.4.3") names += decodeDirectoryString(value)
      }
    }
    return names
  }

  private fun decodeDirectoryString(value: DerValue): String {
    val bytes = value.bytes()
    return when (value.tag) {
      0x0c -> bytes.toString(Charsets.UTF_8).also {
        require(it.toByteArray(Charsets.UTF_8).contentEquals(bytes)) { "invalid UTF-8 directory string" }
      }
      0x13, 0x16 -> {
        require(bytes.all { (it.toInt() and 0xff) in 0x20..0x7e }) { "invalid ASCII directory string" }
        bytes.toString(Charsets.US_ASCII)
      }
      else -> throw IllegalArgumentException("unsupported common-name string encoding")
    }
  }

  private fun requirePositiveInteger(bytes: ByteArray) {
    require(bytes.isNotEmpty()) { "empty DER INTEGER" }
    require((bytes[0].toInt() and 0x80) == 0) { "negative DER INTEGER" }
    require(bytes.size == 1 || bytes[0] != 0.toByte() || (bytes[1].toInt() and 0x80) != 0) {
      "non-minimal DER INTEGER"
    }
  }

  private fun decodeOid(bytes: ByteArray): String {
    require(bytes.isNotEmpty()) { "empty DER OID" }
    var index = 0
    fun component(): Long {
      require(index < bytes.size && bytes[index] != 0x80.toByte()) { "non-canonical DER OID" }
      var value = 0L
      while (true) {
        require(index < bytes.size) { "truncated DER OID" }
        val octet = bytes[index++].toInt() and 0xff
        require(value <= (Long.MAX_VALUE ushr 7)) { "DER OID component overflow" }
        value = (value shl 7) or (octet and 0x7f).toLong()
        if ((octet and 0x80) == 0) return value
      }
    }
    val first = component()
    val values = mutableListOf<Long>()
    when {
      first < 40 -> { values += 0; values += first }
      first < 80 -> { values += 1; values += first - 40 }
      else -> { values += 2; values += first - 80 }
    }
    while (index < bytes.size) values += component()
    return values.joinToString(".")
  }

  internal data class DerValue(
    val tag: Int,
    private val source: ByteArray,
    private val start: Int,
    private val end: Int
  ) {
    fun bytes(): ByteArray = source.copyOfRange(start, end)
    fun reader(): DerReader = DerReader(source, start, end)
  }

  internal class DerReader(
    private val source: ByteArray,
    private var offset: Int = 0,
    private val limit: Int = source.size
  ) {
    fun finished(): Boolean = offset == limit
    fun requireFinished() = require(finished()) { "trailing DER data" }
    fun peekTag(): Int {
      require(offset < limit) { "truncated DER value" }
      return source[offset].toInt() and 0xff
    }
    fun read(expectedTag: Int): DerValue {
      val value = readAny()
      require(value.tag == expectedTag) {
        "unexpected DER tag 0x${value.tag.toString(16)}, expected 0x${expectedTag.toString(16)}"
      }
      return value
    }
    fun readAny(): DerValue {
      require(offset < limit) { "truncated DER tag" }
      val tag = source[offset++].toInt() and 0xff
      require((tag and 0x1f) != 0x1f) { "high-tag-number DER is not accepted" }
      require(offset < limit) { "truncated DER length" }
      val first = source[offset++].toInt() and 0xff
      val length = if ((first and 0x80) == 0) {
        first
      } else {
        val count = first and 0x7f
        require(count in 1..4 && offset + count <= limit) { "invalid DER length" }
        require(source[offset] != 0.toByte()) { "non-minimal DER length" }
        var n = 0L
        repeat(count) { n = (n shl 8) or (source[offset++].toInt() and 0xff).toLong() }
        require(n >= 128 && n <= Int.MAX_VALUE) { "non-canonical DER length" }
        n.toInt()
      }
      require(length <= limit - offset) { "truncated DER content" }
      val start = offset
      offset += length
      return DerValue(tag, source, start, offset)
    }
  }
}
