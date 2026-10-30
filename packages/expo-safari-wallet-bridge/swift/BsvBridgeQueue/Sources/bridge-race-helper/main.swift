import CryptoKit
import Foundation
import BsvBridgeQueue

// Test helper for the cross-process RaceTests (macOS only):
//   bridge-race-helper <root> <keyHex> <startAtEpochMs> <op> <id> [arg]
// Opens its own BridgeStore on the shared root, waits for the common start time so all helpers race,
// runs one operation and prints one result word.
let args = CommandLine.arguments
guard args.count >= 6 else {
  FileHandle.standardError.write(Data("usage\n".utf8))
  exit(2)
}
let root = URL(fileURLWithPath: args[1])
let keyBytes = stride(from: 0, to: args[2].count, by: 2).map { i -> UInt8 in
  let a = args[2].index(args[2].startIndex, offsetBy: i)
  return UInt8(args[2][a...args[2].index(after: a)], radix: 16)!
}
let start = Int64(args[3])!
let op = args[4]
let id = args[5]
let extra = args.count > 6 ? args[6] : ""

do {
  let store = try BridgeStore(root: root, keys: InMemoryKeyProvider(key: SymmetricKey(data: keyBytes)))
  let now = SystemClock().nowMs
  while SystemClock().nowMs < start {}
  switch op {
  case "create": print(try store.create(id: id, bytes: Data("payload-\(extra)".utf8), nowMs: now))
  case "claim":
    let digest = SHA256.hash(data: Data(extra.utf8)).map { String(format: "%02x", $0) }.joined()
    print("\(try store.claim(id: id, digest: digest, bootId: "helper-\(getpid())", nowMs: now))")
  case "accept": print(store.accept(id: id))
  case "withdraw": print(store.withdraw(id: id))
  case "ack":
    store.ack(id: id)
    print("done")
  case "result": print(try store.writeResult(id: id, bytes: Data("r-\(extra)".utf8), nowMs: now))
  case "readResult": print("\(try store.readResult(id: id, nowMs: now))")
  case "sweep":
    try store.sweep(nowMs: Int64(extra)!)
    print("done")
  default: exit(2)
  }
} catch {
  print("error \(error)")
  exit(1)
}
