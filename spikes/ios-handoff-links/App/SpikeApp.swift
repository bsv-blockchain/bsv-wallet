import SwiftUI
import LocalAuthentication

final class Log: ObservableObject {
    static let shared = Log()
    @Published var lines: [String] = []
    func add(_ s: String) {
        DispatchQueue.main.async { self.lines.append(s) }
        let q = ("app: " + s).addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        if let u = URL(string: "https://deggen.ngrok.app/log?m=" + q) {
            URLSession.shared.dataTask(with: u).resume()
        }
    }
}

@main struct SpikeApp: App {
    @StateObject var log = Log.shared
    @State var incoming: URL?
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("Handoff Spike").font(.title)
                Text(incoming?.absoluteString ?? "no incoming URL").font(.footnote)
                Button("Approve (simulate)") { Log.shared.add("approved id=123") }
                    .buttonStyle(.borderedProminent)
                Button("Approve with Face ID") {
                    let c = LAContext(); var e: NSError?
                    if c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) {
                        c.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Approve") { ok, err in
                            Log.shared.add("faceid ok=\(ok) err=\(String(describing: err))")
                        }
                    } else { Log.shared.add("faceid unavailable \(String(describing: e))") }
                }
                Button("Back to Safari") {
                    let u = URL(string: "https://deggen.ngrok.app/return?id=123")!
                    UIApplication.shared.open(u) { ok in Log.shared.add("open return ok=\(ok)") }
                }.buttonStyle(.bordered)
                List(log.lines, id: \.self) { Text($0).font(.caption2) }
            }
            .padding()
            .onOpenURL { u in incoming = u; Log.shared.add("onOpenURL " + u.absoluteString) }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { a in
                incoming = a.webpageURL
                Log.shared.add("userActivity " + (a.webpageURL?.absoluteString ?? "nil"))
            }
        }
    }
}
