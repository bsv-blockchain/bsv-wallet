package com.margelo.nitro.localpaytransport

import org.junit.Assert.*
import org.junit.Test

class NearbyExchangeTest {
  private val psk = ByteArray(32) { it.toByte() }
  private val frame = "payment".toByteArray()
  private val ack = "{\"ok\":true}".toByteArray()

  @Test fun ackRequiresProofAndFrameTransfer() {
    val payer = NearbyExchange.Payer(psk, "session", frame)
    val hello = payer.hello()
    val peer = NearbyExchange.accept(psk, "session", hello)!!
    val message = peer.ack(frame, ack)
    assertNull(payer.receiveAck(message))
    assertTrue(payer.verifyHello(peer.hello()))
    assertNull(payer.receiveAck(message))
    payer.frameTransferred()
    assertArrayEquals(ack, payer.receiveAck(message))
    assertNull(payer.receiveAck(message))
  }

  @Test fun replayAndMutationFail() {
    val old = NearbyExchange.Payer(psk, "session", frame)
    val peer = NearbyExchange.accept(psk, "session", old.hello())!!
    val payer = NearbyExchange.Payer(psk, "session", frame)
    payer.hello()
    assertFalse(payer.verifyHello(peer.hello()))
    val current = NearbyExchange.accept(psk, "session", payer.hello())!!
    assertTrue(payer.verifyHello(current.hello()))
    assertFalse(payer.verifyHello(current.hello()))
    payer.frameTransferred()
    assertNull(payer.receiveAck(peer.ack(frame, ack)))
    assertNull(payer.receiveAck(current.ack("other payment".toByteArray(), ack)))
    val changed = current.ack(frame, ack).also { it[it.lastIndex] = 0 }
    assertNull(payer.receiveAck(changed))
    assertArrayEquals(ack, payer.receiveAck(current.ack(frame, ack)))
  }

  @Test fun authenticatedDeclineIsPreservedAndWrongSecretFails() {
    val payer = NearbyExchange.Payer(psk, "session", frame)
    assertNull(NearbyExchange.accept(ByteArray(32), "session", payer.hello()))
    val peer = NearbyExchange.accept(psk, "session", payer.hello())!!
    payer.verifyHello(peer.hello())
    payer.frameTransferred()
    val decline = "{\"ok\":false,\"error\":\"declined\"}".toByteArray()
    assertArrayEquals(decline, payer.receiveAck(peer.ack(frame, decline)))
  }

  @Test fun invalidHelloAndOversizeAckFail() {
    val payer = NearbyExchange.Payer(psk, "session", frame)
    assertNull(NearbyExchange.accept(psk, "other session", payer.hello()))
    assertNull(NearbyExchange.accept(psk, "session", ByteArray(33)))
    val peer = NearbyExchange.accept(psk, "session", payer.hello())!!
    payer.verifyHello(peer.hello())
    payer.frameTransferred()
    assertNull(payer.receiveAck(peer.ack(frame, ByteArray(4097))))
  }
}
