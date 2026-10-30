import Foundation

/// The Darwin notification the extension posts after staging so a running app drains at once
/// (spec 6.11 `nudge`). Darwin notifications carry no payload and are only delivered to a process
/// that is running and observing; a suspended app picks the work up when it next becomes active.
public enum BridgeNudge {
  public static func name(appGroup: String) -> String { "\(appGroup).bridge.nudge" }

  public static func post(appGroup: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name(appGroup: appGroup) as CFString), nil,
      nil, true)
  }

  /// An active observation. `cancel()` (or releasing it) stops delivery.
  public final class Observation {
    fileprivate let handler: () -> Void
    private var name: String?

    fileprivate init(name: String, handler: @escaping () -> Void) {
      self.name = name
      self.handler = handler
    }

    public func cancel() {
      guard let name else { return }
      self.name = nil
      CFNotificationCenterRemoveObserver(
        CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque(),
        CFNotificationName(name as CFString), nil)
    }

    deinit { cancel() }
  }

  /// The handler runs on an arbitrary thread (the Darwin center delivers on the main queue for apps,
  /// but callers must not rely on it).
  public static func observe(appGroup: String, handler: @escaping () -> Void) -> Observation {
    let n = name(appGroup: appGroup)
    let observation = Observation(name: n, handler: handler)
    CFNotificationCenterAddObserver(
      CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(observation).toOpaque(),
      { _, observer, _, _, _ in
        guard let observer else { return }
        Unmanaged<Observation>.fromOpaque(observer).takeUnretainedValue().handler()
      }, n as CFString, nil, .deliverImmediately)
    return observation
  }
}
