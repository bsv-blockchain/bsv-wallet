import Foundation

let psk = Data(0..<32)
let nonceA = Data(32..<64)
let nonceB = Data(64..<96)
let name = "bsvpay-test"
let frame = Data("payment".utf8)
let decline = Data("{\"ok\":false,\"error\":\"declined\"}".utf8)
func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
func payer(_ nonce: Data = nonceA, _ sealed: Data = frame) -> BleGattProfile.Payer {
  BleGattProfile.Payer(psk: psk, instanceName: name, sealed: sealed, challenge: nonce)
}
func peer(_ payer: BleGattProfile.Payer, _ nonce: Data = nonceB) -> BleGattProfile.Peer {
  BleGattProfile.acceptHelloA(psk: psk, instanceName: name, message: payer.helloA(), responderChallenge: nonce)!
}
let old = payer()
let recipient = peer(old)
precondition(recipient.ackMessage(ackJson: decline) == nil)
recipient.receivedFrame(frame)
precondition(hex(old.helloA()) == "01202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f6498399d807cf50873e33337bb0160beaf5a04dba4ca26da51bb5295e11b827f")
precondition(hex(recipient.helloB()) == "02404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f50eb671549d1f8dcb233cae4bee42e033b2b0c39cdce86e5b1246e99bbc76301")
let captured = recipient.ackMessage(ackJson: decline)!
precondition(hex(captured) == "047b226f6b223a66616c73652c226572726f72223a226465636c696e6564227d826f18371f46c50ba25537f98d1b08cb304c0c52d04c2dbc8f73d441988787c5")
precondition(old.verifyAck(captured) == nil)
precondition(old.verifyHelloB(recipient.helloB()))
precondition(!old.verifyHelloB(recipient.helloB()))
precondition(old.verifyAck(captured) == decline)
precondition(old.verifyAck(captured) == nil)
let retryFrame = Data("retry payment".utf8)
let retry = payer(Data(repeating: 3, count: 32), retryFrame)
precondition(!retry.verifyHelloB(recipient.helloB()))
let current = peer(retry)
precondition(retry.verifyHelloB(current.helloB()))
precondition(retry.verifyAck(captured) == nil)
current.receivedFrame(retryFrame)
precondition(retry.verifyAck(current.ackMessage(ackJson: Data())!) == nil)
precondition(retry.verifyAck(current.ackMessage(ackJson: Data(repeating: 65, count: 4097))!) == nil)
let ack = current.ackMessage(ackJson: decline)!
var altered = ack
altered[2] ^= 1
precondition(retry.verifyAck(altered) == nil)
var assembler = BleGattProfile.Reassembler()
let chunks = BleGattProfile.chunks(BleGattProfile.lengthPrefixed(ack), size: 20)
var messages: [Data] = []
for chunk in chunks { messages += try assembler.feed(chunk) }
precondition(messages.count == 1)
precondition(retry.verifyAck(messages[0]) == decline)
let wrongFrame = payer()
let wrongRecipient = peer(wrongFrame)
precondition(wrongFrame.verifyHelloB(wrongRecipient.helloB()))
wrongRecipient.receivedFrame(Data("other frame".utf8))
precondition(wrongFrame.verifyAck(wrongRecipient.ackMessage(ackJson: decline)!) == nil)
let differentChallenge = peer(wrongFrame, Data(repeating: 4, count: 32))
differentChallenge.receivedFrame(frame)
precondition(wrongFrame.verifyAck(differentChallenge.ackMessage(ackJson: decline)!) == nil)
precondition(BleGattProfile.acceptHelloA(psk: Data(repeating: 0, count: 32), instanceName: name, message: retry.helloA()) == nil)
precondition(BleGattProfile.acceptHelloA(psk: psk, instanceName: name, message: Data([1]) + Data(repeating: 0, count: 32)) == nil)
print("PASS: BLE replay, exact frame, both challenges, chunked decline, tampering, wrong secret, shared Kotlin/Swift vectors")

// Exercise real challenge generation without a radio: repeating a QR must not repeat HELLO_A.
let freshA = BleGattProfile.Payer(psk: psk, instanceName: name, sealed: frame)
let freshB = BleGattProfile.Payer(psk: psk, instanceName: name, sealed: frame)
precondition(freshA.helloA() != freshB.helloA())
let freshPeer = BleGattProfile.acceptHelloA(psk: psk, instanceName: name, message: freshA.helloA())!
precondition(freshA.verifyHelloB(freshPeer.helloB()))
freshPeer.receivedFrame(frame)
freshPeer.receivedFrame(Data("must not replace accepted frame".utf8))
precondition(freshA.verifyAck(freshPeer.ackMessage(ackJson: Data("{\"ok\":true}".utf8))!) != nil)
precondition(!BleGattProfile.constantTimeEquals(Data([1]), Data([1, 2])))
precondition(BleGattProfile.serviceUuid(psk: psk, instanceName: name).uuidString.lowercased() == "7becac61-7070-45cf-95a5-314d9399c021")
precondition(BleGattProfile.declineJson(reason: "") == "{\"ok\":false,\"error\":\"declined\"}")
precondition(BleGattProfile.declineJson(reason: "a \"b\"\\\n") == "{\"ok\":false,\"error\":\"a \\\"b\\\"\\\\\\n\"}")
precondition(BleGattProfile.chunks(Data([1, 2]), size: 0) == [Data([1]), Data([2])])
for invalid in [Data([0, 0, 0, 0]), Data([0, 0, 128, 1]), Data(repeating: 0, count: BleGattProfile.maxReassemblyBytes + 1)] {
  var malformed = BleGattProfile.Reassembler()
  do {
    _ = try malformed.feed(invalid)
    preconditionFailure("invalid GATT framing accepted")
  } catch { }
}
print("PASS: fresh CSPRNG challenges, UUID vector, decline escaping, immutable frame digest, invalid framing")
