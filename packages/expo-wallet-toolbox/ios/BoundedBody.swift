import Foundation

/// Counts decoded response bytes before they enter the accumulated body.
final class BoundedBody {
  enum Error: Swift.Error { case tooLarge }
  let limit: Int
  private(set) var data = Data()

  init(limit: Int) { self.limit = limit }

  func append(_ chunk: Data) throws {
    guard chunk.count <= limit - data.count else { throw Error.tooLarge }
    data.append(chunk)
  }
}
