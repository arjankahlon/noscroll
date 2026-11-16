#if DEBUG
import Foundation
import WebKit

/// Debug builds only (never in the GitHub release build): lets a developer look inside
/// the web views from the Mac while testing in the Simulator.
///
/// - Logs page loads and failures (`xcrun simctl spawn booted log stream --predicate 'subsystem == "following"'`).
/// - Runs `Documents/eval-<tab>.js` in that tab when the file appears, writes the result
///   to `Documents/eval-<tab>.out`, then deletes the .js file.
@MainActor
enum DebugHooks {
    static func log(_ s: String) { NSLog("[following] %@", s) }

    static func attach(_ controller: InstaWebController) {
        controller.webView.isInspectable = true
        let tab = controller.tab.title.lowercased()
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let script = docs.appendingPathComponent("eval-\(tab).js")
        let out = docs.appendingPathComponent("eval-\(tab).out")
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak controller] _ in
            Task { @MainActor in
                guard let controller, let js = try? String(contentsOf: script, encoding: .utf8) else { return }
                try? FileManager.default.removeItem(at: script)
                controller.webView.evaluateJavaScript(js) { result, error in
                    let text = error.map { "ERROR: \($0)" } ?? String(describing: result ?? "nil")
                    try? text.write(to: out, atomically: true, encoding: .utf8)
                }
            }
        }
    }
}
#endif
