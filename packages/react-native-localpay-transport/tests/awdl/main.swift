import Foundation
import Darwin
import Network

let serviceName = "awdl-test-\(UUID().uuidString.prefix(8))"
let psk = Data(repeating: 7, count: 32)
let identity = Data(serviceName.utf8)
let transport = HybridLocalPayTransport()
let received = DispatchSemaphore(value: 0)
let probeFinished = DispatchSemaphore(value: 0)
let io = DispatchQueue(label: "awdl-test")
let lock = NSLock()
var errors: [String] = []
var receivedFrame: String?
_ = try transport.startListening(instanceName: serviceName, pskBase64: psk.base64EncodedString(), onFrame: {
  lock.lock(); receivedFrame = $0; lock.unlock()
  received.signal()
}, onError: {
  lock.lock(); errors.append($0); lock.unlock()
})
// Inspect the listener only to obtain its ephemeral TCP port; the tested
// transport, callbacks, TLS and framed IO remain the production implementation.
let listener = Mirror(reflecting: transport).children.first { $0.label == "listener" }!.value as! NWListener?
var port: NWEndpoint.Port?
for _ in 0..<100 {
  port = listener?.port
  if port != nil { break }
  Thread.sleep(forTimeInterval: 0.02)
}
precondition(port != nil, "test listener did not bind")
let target = NWEndpoint.hostPort(host: "127.0.0.1", port: port!)
// A correct-PSK peer that closes after one header byte exercises the same
// connection-local failure branch without depending on TLS failure timing.
let probe = NWConnection(to: target, using: AwdlSession.parameters(psk: psk, identity: identity))
probe.stateUpdateHandler = { state in
  if case .waiting(.posix(.EPERM)) = state {
    FileHandle.standardError.write(Data("SKIP: Network.framework connection denied by host sandbox\n".utf8))
    exit(77)
  }
  if case .ready = state {
    probe.send(content: Data([0]), completion: .contentProcessed { _ in
      probe.cancel()
      probeFinished.signal()
    })
  }
}
probe.start(queue: io)
precondition(probeFinished.wait(timeout: .now() + 10) == .success, "probe did not connect")
Thread.sleep(forTimeInterval: 0.5)
lock.lock(); let errorsAfterProbe = errors; lock.unlock()
precondition(errorsAfterProbe.isEmpty, "peer read error escaped to listener: \(errorsAfterProbe)")
let valid = NWConnection(to: target, using: AwdlSession.parameters(psk: psk, identity: identity))
let frame = Data("valid payment after failed probe".utf8)
valid.stateUpdateHandler = { state in
  if case .ready = state {
    valid.send(content: AwdlSession.lengthPrefixed(frame), completion: .contentProcessed { _ in })
  }
}
valid.start(queue: io)
precondition(received.wait(timeout: .now() + 10) == .success, "same listener did not accept legitimate payer")
lock.lock(); let actual = receivedFrame; lock.unlock()
precondition(actual == frame.base64EncodedString())
_ = try transport.confirmFrame(accepted: true, reason: "")
_ = try transport.stopListening()
valid.cancel()
print("PASS: peer failure isolated; same advertised listener accepts valid payment")
