package com.margelo.nitro.localpaytransport

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Nearby v2: a fresh payer challenge authenticates the proof and exact-frame ACK. */
internal object NearbyExchange {
  private const val NONCE_BYTES = 32
  private const val MAC_BYTES = 32
  private const val MAX_ACK_BYTES = 4096

  private fun mac(psk: ByteArray, name: String, role: Byte, nonce: ByteArray, body: ByteArray = byteArrayOf()): ByteArray {
    val h = Mac.getInstance("HmacSHA256")
    h.init(SecretKeySpec(psk, "HmacSHA256"))
    h.update("bsvpay-nearby/2\u0000".toByteArray())
    h.update(name.toByteArray(Charsets.UTF_8))
    h.update(0.toByte())
    h.update(role)
    h.update(nonce)
    return h.doFinal(body)
  }

  class Peer internal constructor(private val psk: ByteArray, private val name: String, private val nonce: ByteArray) {
    fun hello(): ByteArray = byteArrayOf(2) + mac(psk, name, 2, nonce)
    fun ack(frame: ByteArray, json: ByteArray): ByteArray = byteArrayOf(4) +
      mac(psk, name, 4, nonce, MessageDigest.getInstance("SHA-256").digest(frame) + json) + json
  }

  fun accept(psk: ByteArray, name: String, hello: ByteArray): Peer? {
    if (hello.size != 1 + NONCE_BYTES + MAC_BYTES || hello[0] != 1.toByte()) return null
    val nonce = hello.copyOfRange(1, 1 + NONCE_BYTES)
    if (!MessageDigest.isEqual(hello.copyOfRange(1 + NONCE_BYTES, hello.size), mac(psk, name, 1, nonce))) return null
    return Peer(psk, name, nonce)
  }

  class Payer(private val psk: ByteArray, private val name: String, frame: ByteArray) {
    private val nonce = ByteArray(NONCE_BYTES).also { SecureRandom().nextBytes(it) }
    private val digest = MessageDigest.getInstance("SHA-256").digest(frame)
    private var authenticated = false
    private var transferred = false
    private var acknowledged = false

    fun hello(): ByteArray = byteArrayOf(1) + nonce + mac(psk, name, 1, nonce)
    fun verifyHello(hello: ByteArray): Boolean {
      if (authenticated || hello.size != 1 + MAC_BYTES || hello[0] != 2.toByte()) return false
      if (!MessageDigest.isEqual(hello.copyOfRange(1, hello.size), mac(psk, name, 2, nonce))) return false
      authenticated = true
      return true
    }
    fun frameTransferred() { if (authenticated) transferred = true }
    fun receiveAck(message: ByteArray): ByteArray? {
      if (!authenticated || !transferred || acknowledged || message.size <= 1 + MAC_BYTES ||
        message.size > 1 + MAC_BYTES + MAX_ACK_BYTES || message[0] != 4.toByte()) return null
      val json = message.copyOfRange(1 + MAC_BYTES, message.size)
      if (!MessageDigest.isEqual(message.copyOfRange(1, 1 + MAC_BYTES), mac(psk, name, 4, nonce, digest + json))) return null
      acknowledged = true
      return json
    }
  }
}
