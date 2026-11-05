package com.margelo.nitro.localpaytransport

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.UUID

/**
 * Known-answer vectors for the bsvpay-ble/2 wire helpers. The same vectors
 * are the cross-platform check against ios/BleGattProfile.swift: psk is the
 * bytes 0x00..0x1f, instanceName "bsvpay-test".
 */
class BleGattProfileTest {
  private val psk = ByteArray(32) { it.toByte() }
  private val name = "bsvpay-test"

  private fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

  @Test
  fun serviceUuidMatchesVectorWithRfc4122Bits() {
    assertEquals(
      UUID.fromString("7becac61-7070-45cf-95a5-314d9399c021"),
      BleGattProfile.serviceUuid(psk, name)
    )
  }

  @Test
  fun serviceUuidIsAlwaysVersion4Variant10() {
    for (i in 0 until 64) {
      val u = BleGattProfile.serviceUuid(ByteArray(32) { (i * 7 + it).toByte() }, "bsvpay-$i")
      assertEquals("version nibble for $i", 4, u.version())
      assertEquals("variant bits for $i", 2, u.variant())
    }
  }

  @Test fun frameMessageIsTypeByteThenSealedBytes() {
    val sealed = byteArrayOf(9, 8, 7)
    assertArrayEquals(byteArrayOf(BleGattProfile.TYPE_FRAME, 9, 8, 7), BleGattProfile.frameMessage(sealed))
  }

  @Test
  fun ackJsonMatchesTheOtherBackendsByteForByte() {
    assertEquals("{\"ok\":true}", BleGattProfile.ackJson(true, "ignored"))
    assertEquals("{\"ok\":false,\"error\":\"declined\"}", BleGattProfile.ackJson(false, ""))
    assertEquals("{\"ok\":false,\"error\":\"already_paid\"}", BleGattProfile.ackJson(false, "already_paid"))
    assertEquals(
      "{\"ok\":false,\"error\":\"a \\\"b\\\"\\\\\\n\"}",
      BleGattProfile.ackJson(false, "a \"b\"\\\n")
    )
    assertEquals("\"\\u0001\"", BleGattProfile.jsonString("\u0001"))
  }

  @Test
  fun lengthPrefixIsBigEndianU32() {
    val body = ByteArray(0x010203) { 1 }
    val framed = BleGattProfile.lengthPrefixed(body)
    assertEquals(4 + 0x010203, framed.size)
    assertEquals(0, framed[0].toInt())
    assertEquals(1, framed[1].toInt())
    assertEquals(2, framed[2].toInt())
    assertEquals(3, framed[3].toInt())
    assertEquals(1, framed[4].toInt())
  }

  @Test
  fun chunksNeverExceedMtuMinusThreeOrTheHardCeiling() {
    assertEquals(20, BleGattProfile.chunkSize(23))
    // Android's stack rejects notifyCharacteristicChanged/indication payloads over 512
    // bytes regardless of negotiated MTU (2026-09-03 hardware finding) — mtu-3=514 at
    // MTU=517 must still clamp to 512, not pass the raw mtu-3 value through.
    assertEquals(512, BleGattProfile.chunkSize(517))
    assertEquals(1, BleGattProfile.chunkSize(0))
    val framed = BleGattProfile.lengthPrefixed(ByteArray(1000) { it.toByte() })
    val small = BleGattProfile.chunk(framed, 23)
    assertTrue(small.all { it.size <= 20 })
    assertEquals(20, small.first().size)
    assertEquals(1004, small.sumOf { it.size })
    val large = BleGattProfile.chunk(framed, 517)
    assertEquals(2, large.size)
    assertEquals(512, large.first().size)
    assertEquals(492, large.last().size)
  }

  @Test
  fun reassemblerRebuildsAcrossChunkBoundaries() {
    val message = ByteArray(5000) { (it * 3).toByte() }
    val r = BleGattProfile.Reassembler()
    val out = mutableListOf<ByteArray>()
    for (c in BleGattProfile.chunk(BleGattProfile.lengthPrefixed(message), 23)) out += r.feed(c)
    assertEquals(1, out.size)
    assertArrayEquals(message, out[0])

    val a = byteArrayOf(1, 2, 3)
    val b = byteArrayOf(4)
    val both = r.feed(BleGattProfile.lengthPrefixed(a) + BleGattProfile.lengthPrefixed(b))
    assertEquals(2, both.size)
    assertArrayEquals(a, both[0])
    assertArrayEquals(b, both[1])
  }

  @Test
  fun reassemblerRejectsOversizeAndZeroLength() {
    try {
      BleGattProfile.Reassembler().feed(BleGattProfile.lengthPrefixed(ByteArray(BleGattProfile.MAX_BLE_FRAME_BYTES + 1)))
      fail("expected IllegalArgumentException for 32769 bytes")
    } catch (e: IllegalArgumentException) {
      assertTrue(e.message!!.contains("32769"))
    }
    try {
      BleGattProfile.Reassembler().feed(byteArrayOf(0, 0, 0, 0))
      fail("expected IllegalArgumentException for a zero-length message")
    } catch (e: IllegalArgumentException) {
      // expected
    }
    // Exactly the ceiling is accepted: only the header is fed, so nothing completes and nothing throws.
    val atCap = BleGattProfile.Reassembler().feed(byteArrayOf(0, 0, 0x80.toByte(), 0))
    assertEquals(0, atCap.size)
  }

  /**
   * A rejected length prefix must not leave the instance mid-header. The
   * payee keeps the central it is holding for the ack alive across a framing
   * refusal, so that same Reassembler sees the peer's next write: with
   * headerFilled stuck at 4 and a null body, that byte used to be written to
   * header[4] and the ArrayIndexOutOfBoundsException escaped the GATT
   * callback's main.post runnable and killed the process.
   */
  @Test
  fun reassemblerResynchronisesAfterARejectedLengthPrefix() {
    val message = byteArrayOf(7, 7, 7)

    val oversize = BleGattProfile.Reassembler()
    try {
      oversize.feed(byteArrayOf(0, 1, 0, 0)) // declared 65536 > MAX_BLE_FRAME_BYTES
      fail("expected IllegalArgumentException for an oversize length prefix")
    } catch (e: IllegalArgumentException) {
      assertTrue(e.message!!.contains("65536"))
    }
    val afterOversize = oversize.feed(BleGattProfile.lengthPrefixed(message))
    assertEquals(1, afterOversize.size)
    assertArrayEquals(message, afterOversize[0])

    val zero = BleGattProfile.Reassembler()
    try {
      zero.feed(byteArrayOf(0, 0, 0, 0))
      fail("expected IllegalArgumentException for a zero-length prefix")
    } catch (e: IllegalArgumentException) {
      // expected
    }
    val afterZero = zero.feed(BleGattProfile.lengthPrefixed(message))
    assertEquals(1, afterZero.size)
    assertArrayEquals(message, afterZero[0])

    // reset() is also callable directly, mid-record, by a caller keeping the peer alive.
    val partial = BleGattProfile.Reassembler()
    assertEquals(0, partial.feed(byteArrayOf(0, 0, 0, 9, 1, 2)).size)
    partial.reset()
    val afterReset = partial.feed(BleGattProfile.lengthPrefixed(message))
    assertEquals(1, afterReset.size)
    assertArrayEquals(message, afterReset[0])
  }

  @Test
  fun verifyAck_acceptsTheAckMessageBuiltByThePeer() {
    // Reversed role: the payer (Android) now verifies an ACK the payee built.
    // Both BLE role arrangements use the same fresh exchange transcript.
    val psk = ByteArray(32) { it.toByte() }
    val name = "bsvpay-ob6nb2nqxvazcq2bx33et5ama4"
    val json = "{\"ok\":true}".toByteArray(Charsets.UTF_8)
    val payer = BleGattProfile.Payer(psk, name, byteArrayOf(1, 2, 3))
    val peer = BleGattProfile.acceptHelloA(psk, name, payer.helloA())!!
    assertTrue(payer.verifyHelloB(peer.helloB()))
    peer.receivedFrame(byteArrayOf(1, 2, 3))
    val message = peer.ackMessage(json)!!
    // One flipped MAC bit is refused.
    val tampered = message.copyOf(); tampered[tampered.size - 1] = (tampered.last().toInt() xor 1).toByte()
    assertNull(payer.verifyAck(tampered))
    assertArrayEquals(json, payer.verifyAck(message))
  }
}
