package com.margelo.nitro.localpaytransport

import org.junit.Assert.*
import org.junit.Test

class BleExchangeTest {
  private val psk = ByteArray(32) { it.toByte() }
  private val name = "bsvpay-test"
  private val frame = "payment".toByteArray()
  private val decline = "{\"ok\":false,\"error\":\"declined\"}".toByteArray()
  private val nonceA = ByteArray(32) { (it + 32).toByte() }
  private val nonceB = ByteArray(32) { (it + 64).toByte() }
  private fun payer(nonce: ByteArray = nonceA, sealed: ByteArray = frame) = BleGattProfile.Payer(psk, name, sealed, nonce)
  private fun peer(payer: BleGattProfile.Payer, nonce: ByteArray = nonceB) = BleGattProfile.acceptHelloA(psk, name, payer.helloA(), nonce)!!
  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

  @Test fun recordedDeclineFailsOnRetry() {
    val old = payer()
    val oldPeer = peer(old)
    oldPeer.receivedFrame(frame)
    assertTrue(old.verifyHelloB(oldPeer.helloB()))
    val captured = oldPeer.ackMessage(decline)!!
    assertArrayEquals(decline, old.verifyAck(captured))
    val retry = payer(ByteArray(32) { 3 }, "retry payment".toByteArray())
    assertFalse(retry.verifyHelloB(oldPeer.helloB()))
    val currentPeer = peer(retry)
    assertTrue(retry.verifyHelloB(currentPeer.helloB()))
    assertNull(retry.verifyAck(captured))
    currentPeer.receivedFrame("retry payment".toByteArray())
    assertArrayEquals(decline, retry.verifyAck(currentPeer.ackMessage(decline)!!))
    assertNull(retry.verifyAck(currentPeer.ackMessage(decline)!!))
  }

  @Test fun exactFrameAndBothChallengesAreBound() {
    val p = payer()
    val r = peer(p)
    assertTrue(p.verifyHelloB(r.helloB()))
    assertFalse(p.verifyHelloB(r.helloB()))
    r.receivedFrame("other frame".toByteArray())
    assertNull(p.verifyAck(r.ackMessage(decline)!!))
    val otherPeer = peer(p, ByteArray(32) { 4 })
    otherPeer.receivedFrame(frame)
    assertNull(p.verifyAck(otherPeer.ackMessage(decline)!!))
  }

  @Test fun validChunkedExchangeAndTamperChecks() {
    val p = payer()
    val r = peer(p)
    assertNull(p.verifyAck(byteArrayOf(4)))
    assertTrue(p.verifyHelloB(r.helloB()))
    r.receivedFrame(frame)
    assertNull(p.verifyAck(r.ackMessage(ByteArray(0))!!))
    assertNull(p.verifyAck(r.ackMessage(ByteArray(4097))!!))
    val ack = r.ackMessage(decline)!!
    assertNull(p.verifyAck(ack.copyOf().also { it[2] = (it[2].toInt() xor 1).toByte() }))
    val reassembler = BleGattProfile.Reassembler()
    val messages = BleGattProfile.chunk(BleGattProfile.lengthPrefixed(ack), 23).flatMap { reassembler.feed(it) }
    assertEquals(1, messages.size)
    assertArrayEquals(decline, p.verifyAck(messages.single()))
    assertNull(BleGattProfile.acceptHelloA(ByteArray(32), name, p.helloA()))
    assertNull(BleGattProfile.acceptHelloA(psk, name, byteArrayOf(1) + ByteArray(32)))
  }

  @Test fun sharedWireVectors() {
    val p = payer()
    val r = peer(p)
    r.receivedFrame(frame)
    assertEquals("01202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f6498399d807cf50873e33337bb0160beaf5a04dba4ca26da51bb5295e11b827f", hex(p.helloA()))
    assertEquals("02404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f50eb671549d1f8dcb233cae4bee42e033b2b0c39cdce86e5b1246e99bbc76301", hex(r.helloB()))
    assertEquals("047b226f6b223a66616c73652c226572726f72223a226465636c696e6564227d826f18371f46c50ba25537f98d1b08cb304c0c52d04c2dbc8f73d441988787c5", hex(r.ackMessage(decline)!!))
  }
}
