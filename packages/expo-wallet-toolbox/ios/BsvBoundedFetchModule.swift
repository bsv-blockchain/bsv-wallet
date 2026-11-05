import ExpoModulesCore
import Foundation

public final class BsvBoundedFetchModule: Module {
  private let lock = NSLock()
  private var requests: [String: BoundedRequest] = [:]

  public func definition() -> ModuleDefinition {
    Name("BsvBoundedFetch")

    AsyncFunction("request") { (options: [String: Any], promise: Promise) in
      guard let id = options["id"] as? String,
            let address = options["url"] as? String,
            let url = URL(string: address), url.scheme == "https",
            let limit = options["maxBytes"] as? Int, (0...67108864).contains(limit) else {
        promise.reject("ERR_INVALID_REQUEST", "Invalid bounded HTTPS request")
        return
      }
      var request = URLRequest(url: url)
      request.httpMethod = options["method"] as? String ?? "GET"
      for header in options["headers"] as? [[String]] ?? [] where header.count == 2 {
        request.setValue(header[1], forHTTPHeaderField: header[0])
      }
      if let encoded = options["body"] as? String { request.httpBody = Data(base64Encoded: encoded) }
      let receiver = BoundedRequest(limit: limit) { result in
        self.lock.lock()
        self.requests.removeValue(forKey: id)
        self.lock.unlock()
        switch result {
        case .success(let reply): promise.resolve(reply)
        case .failure(let error): promise.reject("ERR_BOUNDED_FETCH", error.localizedDescription)
        }
      }
      self.lock.lock()
      self.requests[id] = receiver
      self.lock.unlock()
      receiver.start(request)
    }

    AsyncFunction("cancel") { (id: String) in
      self.lock.lock()
      let receiver = self.requests[id]
      self.lock.unlock()
      receiver?.cancel()
    }

    OnDestroy {
      self.lock.lock()
      let active = Array(self.requests.values)
      self.requests.removeAll()
      self.lock.unlock()
      active.forEach { $0.cancel() }
    }
  }
}

/// URLSession supplies decoded chunks; the only accumulating buffer is capped
/// synchronously on its serial delegate queue, before bytes can cross to JS.
private final class BoundedRequest: NSObject, URLSessionDataDelegate {
  private let body: BoundedBody
  private let completion: (Result<[String: Any], Swift.Error>) -> Void
  private var session: URLSession?
  private var response: HTTPURLResponse?
  private var failure: Swift.Error?

  init(limit: Int, completion: @escaping (Result<[String: Any], Swift.Error>) -> Void) {
    self.body = BoundedBody(limit: limit)
    self.completion = completion
  }

  func start(_ request: URLRequest) {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 30
    config.timeoutIntervalForResource = 30
    config.httpCookieStorage = nil
    config.urlCache = nil
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.session = session
    session.dataTask(with: request).resume()
  }

  func cancel() { session?.invalidateAndCancel() }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    self.response = response as? HTTPURLResponse
    if response.expectedContentLength > Int64(body.limit) {
      failure = NSError(domain: "ERR_RESPONSE_TOO_LARGE", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "ERR_RESPONSE_TOO_LARGE"])
      completionHandler(.cancel)
    } else {
      completionHandler(.allow)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do { try body.append(data) } catch {
      failure = NSError(domain: "ERR_RESPONSE_TOO_LARGE", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "ERR_RESPONSE_TOO_LARGE"])
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Swift.Error?) {
    defer { session.finishTasksAndInvalidate() }
    if let error = failure ?? error { completion(.failure(error)); return }
    guard let response = response else {
      completion(.failure(URLError(.badServerResponse)))
      return
    }
    let headers = response.allHeaderFields.map { [String(describing: $0.key), String(describing: $0.value)] }
    completion(.success(["status": response.statusCode, "headers": headers, "body": body.data.base64EncodedString()]))
  }
}
