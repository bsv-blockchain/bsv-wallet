import Foundation

@main struct Tests {
  static func main() throws {
    let body = BoundedBody(limit: 3)
    try body.append(Data([1, 2]))
    do { try body.append(Data([3, 4])); fatalError("accepted oversized body") } catch BoundedBody.Error.tooLarge {}
    precondition(body.data == Data([1, 2]), "oversized bytes were buffered")
    try body.append(Data([3]))
    precondition(body.data == Data([1, 2, 3]))
    let empty = BoundedBody(limit: 0)
    do { try empty.append(Data([1])); fatalError("accepted oversized body") } catch BoundedBody.Error.tooLarge {}
    precondition(empty.data.isEmpty)
    print("BoundedBody Swift tests passed")
  }
}
