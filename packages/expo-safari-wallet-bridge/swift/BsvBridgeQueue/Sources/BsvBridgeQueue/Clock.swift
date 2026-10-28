import Foundation

/// Every time-dependent store operation takes `nowMs` from its caller; a `Clock` is how a caller
/// (the app, or a test) produces it. The extension passes real time, the app its injectable clock.
public protocol Clock {
  var nowMs: Int64 { get }
}

public struct SystemClock: Clock {
  public init() {}
  public var nowMs: Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
}
