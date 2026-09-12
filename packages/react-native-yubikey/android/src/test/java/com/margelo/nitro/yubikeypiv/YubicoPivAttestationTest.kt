package com.margelo.nitro.yubikeypiv

import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class YubicoPivAttestationTest {
  @Test
  fun `official production bundle matches the exact pin set`() {
    val stream = checkNotNull(javaClass.getResourceAsStream("/yubico-vault-attestation.pem"))
    val authorities = YubicoPivAttestation.loadAuthorities(stream)
    assertEquals(3, authorities.legacyRoots.size)
    assertEquals(2, authorities.branchIntermediates.size)
    assertEquals(3, authorities.pivIntermediates.size)
  }

  @Test
  fun `valid slot statement binds chain serial policy slot and exact key`() {
    val root = cert(ROOT)
    val f9 = cert(F9)
    val leaf = cert(LEAF)
    val authorities = syntheticAuthorities(root)

    YubicoPivAttestation.verifyFactoryCertificate(f9, SERIAL, authorities)
    YubicoPivAttestation.verifyGeneratedVaultKey(
      leaf,
      f9,
      sec1(leaf),
      SERIAL,
      authorities
    )
  }

  @Test
  fun `wrong generated key is rejected`() {
    val root = cert(ROOT)
    val f9 = cert(F9)
    val leaf = cert(LEAF)
    val wrong = sec1(leaf).also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
    assertThrows(IllegalArgumentException::class.java) {
      YubicoPivAttestation.verifyGeneratedVaultKey(
        leaf, f9, wrong, SERIAL, syntheticAuthorities(root)
      )
    }
  }

  @Test
  fun `wrong serial and wrong policy are rejected`() {
    val root = cert(ROOT)
    val f9 = cert(F9)
    val authorities = syntheticAuthorities(root)
    assertThrows(IllegalArgumentException::class.java) {
      YubicoPivAttestation.verifyFactoryCertificate(f9, "12345679", authorities)
    }
    val badPolicy = cert(BAD_POLICY)
    assertThrows(IllegalArgumentException::class.java) {
      YubicoPivAttestation.verifyGeneratedVaultKey(
        badPolicy, f9, sec1(badPolicy), SERIAL, authorities
      )
    }
  }

  @Test
  fun `unknown factory chain and noncanonical DER fail closed`() {
    val f9 = cert(F9)
    val leaf = cert(LEAF)
    val noRoots = YubicoPivAttestation.Authorities(emptyList(), cert(ROOT), emptyList(), emptyList())
    assertThrows(IllegalArgumentException::class.java) {
      YubicoPivAttestation.verifyFactoryCertificate(f9, SERIAL, noRoots)
    }
    val trailing = leaf.encoded + byteArrayOf(0)
    assertThrows(IllegalArgumentException::class.java) {
      YubicoPivAttestation.parseCertificateDer(trailing)
    }
  }

  private fun syntheticAuthorities(root: X509Certificate) =
    YubicoPivAttestation.Authorities(listOf(root), root, emptyList(), emptyList())

  private fun cert(base64: String): X509Certificate =
    CertificateFactory.getInstance("X.509").generateCertificate(
      Base64.getDecoder().decode(base64).inputStream()
    ) as X509Certificate

  private fun sec1(cert: X509Certificate): ByteArray {
    val key = cert.publicKey as ECPublicKey
    fun coordinate(value: java.math.BigInteger): ByteArray {
      val bytes = value.toByteArray().let { if (it.size == 33 && it[0] == 0.toByte()) it.copyOfRange(1, 33) else it }
      return ByteArray(32 - bytes.size) + bytes
    }
    return byteArrayOf(4) + coordinate(key.w.affineX) + coordinate(key.w.affineY)
  }

  companion object {
    private const val SERIAL = "12345678"
    private const val ROOT = "MIIDKDCCAhCgAwIBAgIUFj7JHtqPF71FndphVeksnp/VCUkwDQYJKoZIhvcNAQELBQAwGjEYMBYGA1UEAwwPVmF1bHQgVGVzdCBSb290MB4XDTI2MDkxMTIwMTkxOVoXDTM2MDkwODIwMTkxOVowGjEYMBYGA1UEAwwPVmF1bHQgVGVzdCBSb290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtsvO3E1cMCoDJu8HD+U6utBdMmfsugAeJRWllwMwLOCQws4cMO/1fVxuHIO9Kb5rF5vXZrFcVk3crZujL15+R1fgkYuy1335IwGS8u6DUVgHPMPfaYMhVPT6tPk2fSJaVaJdWdkNRurugoY/30XFb/wEpWd4df1/eA+84JqhvwBeorFIDspITZYq3ow7U/AW2f9wKOdH/tRzR1xJxrCQtvHeLS9VOJj123R2pKhFXvNVVNmbfegIMfot3mWhsJDvEHDOarAst/jFyVkdgEmm4lTHjNWT+JXI5AhU9hrB9c5t/rCCX27hsAzB9tm+2aASqBlpCtvLHrIhUD19ZqM+twIDAQABo2YwZDAdBgNVHQ4EFgQUKduBsLHZ3+xTKdNrkrKdDSfymYYwHwYDVR0jBBgwFoAUKduBsLHZ3+xTKdNrkrKdDSfymYYwEgYDVR0TAQH/BAgwBgEB/wIBATAOBgNVHQ8BAf8EBAMCAQYwDQYJKoZIhvcNAQELBQADggEBALHjXcDDKZ2JN5LlaowgBxw8MkAnn6mD+so43pFPFZI/qxzcSpQa+hVdH3S4YLp/I6/Nxr9v/7FlktKsNHdWZdDTfo2D+VnfEJNtWalSGjPb4t5afOgWUphbiaCdpdL5AWCl4UPtZZlARQ0NH6YwkhKKUk95h/mWEzh+ZBCNCw8f+xPnvmRhvJP5V1gVbtMCZ5QftdheygJ/EI0gatk0vHZ4EudEcsZUfDETuQc4wdljuoX9tZ/xb5XAtp0M8SBTt3FP84LD84YeD07bXU98WG3FEhND57vubt7p1+XgE0AEaykggDNMQAot0qZFzq/Y4vslF0zpXA/Y2cLvXdWed3w="
    private const val F9 = "MIICWzCCAUOgAwIBAgIUEpfU6Zn9/Rc8FNMsgLt/4pRXtywwDQYJKoZIhvcNAQELBQAwGjEYMBYGA1UEAwwPVmF1bHQgVGVzdCBSb290MB4XDTI2MDkxMTIwMTkxOVoXDTM2MDkwODIwMTkxOVowGDEWMBQGA1UEAwwNVmF1bHQgVGVzdCBGOTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABO7/k4e6Ccp1jKDrqiojEftWxhh/DZXp7uEWMV+FS+dYyQIvMmp0uLyp8kGA9Vu2ihMtm4DAZr27hd1O72e0m+qjZjBkMAwGA1UdEwEB/wQCMAAwFAYKKwYBBAGCxAoDBwQGAgQAvGFOMB0GA1UdDgQWBBR5xvJYZO9X/OddUJYvlFa9PLwOaDAfBgNVHSMEGDAWgBQp24Gwsdnf7FMp02uSsp0NJ/KZhjANBgkqhkiG9w0BAQsFAAOCAQEAPL+kVfoAX6dlo68We9fSqqvpUwtJuFC8jkKXR0uNMZVErdusAnW2uR7G32clu9hODkczVddLVy2L2e73bxKbpCb1zd0Dj20JUVrMmlsxh6WbWtiJgwUYIH8viuYm5kno7harlrorggG4dDHzJ3BWG33R2TNgA9OUdxshU1MPoAbQTwUytDQljKreDoASCRghhQhR02v4h2c9FBkF+abInX5mQxlPV9CPvh68Zi0FpKiwB82os5N2TVZpdec8fj6cljjhqQrYHE9uohG1AFRhMDAKIBlumgyPxDr+Tldh7uNIaNlDPsK4ETV5UYIR13OD7xH77HdYmnj0iNtPH0W7Fw=="
    private const val LEAF = "MIIBtzCCAV2gAwIBAgIUG6aQF9wPksTrGtUCSSY1tEZjxcYwCgYIKoZIzj0EAwIwGDEWMBQGA1UEAwwNVmF1bHQgVGVzdCBGOTAeFw0yNjA5MTEyMDE5MTlaFw0zNjA5MDgyMDE5MTlaMCUxIzAhBgNVBAMMGll1YmlLZXkgUElWIEF0dGVzdGF0aW9uIDgyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWPXsJJv3F3mJK1w5UohvZOg5Yb/ey1uE4v0eqqHVm9pmBZroHu4M7rcvDg1qRRBfjH0R3AcLFCRLbgjYQa7mPaN4MHYwDAYDVR0TAQH/BAIwADAUBgorBgEEAYLECgMHBAYCBAC8YU4wEAYKKwYBBAGCxAoDCAQCAgMwHQYDVR0OBBYEFHnuZgBUdYfqYpMcZPglbM6FIBUJMB8GA1UdIwQYMBaAFHnG8lhk71f8511Qli+UVr08vA5oMAoGCCqGSM49BAMCA0gAMEUCICIA85opPxFERO5VNawD17l+yHAqDc6AOM/eBFpKa9uEAiEA1XTmK/OKfLj94SMJCkJ6+tfIxBaaSajK+K9ybFBS/vg="
    private const val BAD_POLICY = "MIIBtzCCAV2gAwIBAgIUG6aQF9wPksTrGtUCSSY1tEZjxccwCgYIKoZIzj0EAwIwGDEWMBQGA1UEAwwNVmF1bHQgVGVzdCBGOTAeFw0yNjA5MTEyMDE5MTlaFw0zNjA5MDgyMDE5MTlaMCUxIzAhBgNVBAMMGll1YmlLZXkgUElWIEF0dGVzdGF0aW9uIDgyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWPXsJJv3F3mJK1w5UohvZOg5Yb/ey1uE4v0eqqHVm9pmBZroHu4M7rcvDg1qRRBfjH0R3AcLFCRLbgjYQa7mPaN4MHYwDAYDVR0TAQH/BAIwADAUBgorBgEEAYLECgMHBAYCBAC8YU4wEAYKKwYBBAGCxAoDCAQCAgIwHQYDVR0OBBYEFHnuZgBUdYfqYpMcZPglbM6FIBUJMB8GA1UdIwQYMBaAFHnG8lhk71f8511Qli+UVr08vA5oMAoGCCqGSM49BAMCA0gAMEUCICtRvb2wKV5LuLp/s6t31H1ZNDQGq+U10gyple+tfZ2fAiEApIe1FWPws8W6T3UnY8/6hl3ktc/G7LTS4o3Has2ryhk="
  }
}
