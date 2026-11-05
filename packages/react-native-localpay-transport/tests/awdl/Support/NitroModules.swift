// Bridge-only stand-in for compiling the production transport in a macOS test.
// Network.framework and AwdlSession are real, including their TLS-PSK stack.
public final class Promise<T> {
  public init() {}
  public func resolve(withResult result: T) {}
  public func reject(withError error: Error) {}
}
