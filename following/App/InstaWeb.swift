import AVFoundation
import SafariServices
import SwiftUI
import UIKit
import WebKit

/// Shared pieces for the four tab browsers.
enum InstaWeb {
    static let usernameKey = "following.username"

    /// All four tabs use the same persistent cookie jar, so you sign in once.
    static let dataStore = WKWebsiteDataStore.default()

    /// The NoScroll engine, unchanged from upstream (ios/NoScroll/Resources/noscroll.js).
    static let engineSource: String = {
        guard let url = Bundle.main.url(forResource: "noscroll", withExtension: "js"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }()

    /// This app's own Instagram rules (following/Resources/instagram.json). Unsigned on
    /// purpose: it is your file to edit, and the app reads it straight from the bundle.
    static let rulesJSON: String = {
        guard let url = Bundle.main.url(forResource: "instagram", withExtension: "json"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "{}" }
        return s
    }()

    /// This app's extras on top of the engine (following/Resources/extras.js).
    static let extrasSource: String = {
        guard let url = Bundle.main.url(forResource: "extras", withExtension: "js"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }()

    /// Learns which accounts are private from Instagram's own responses (following/Resources/privacy-hook.js).
    static let privacyHookSource: String = {
        guard let url = Bundle.main.url(forResource: "privacy-hook", withExtension: "js"),
              let s = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return s
    }()

    /// Hosts that open inside the app. Anything else opens in a Safari sheet.
    static func staysInApp(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return true }
        let allowed = ["instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net"]
        return allowed.contains { host == $0 || host.hasSuffix("." + $0) }
    }
}

/// One tab's browser.
@MainActor
final class InstaWebController: NSObject, ObservableObject {
    let tab: InstaTab
    let webView: WKWebView
    private var loaded = false
    /// Messages from the page other than the username (for example the story strip's height).
    var onMessage: ((String, Any?) -> Void)?
    /// Called on pull to refresh, after this tab reloads.
    var onRefresh: (() -> Void)?

    init(tab: InstaTab) {
        self.tab = tab

        let content = WKUserContentController()
        // The engine runs at document start so hidden parts never paint.
        let bootstrap = """
        window.__NOSCROLL_CONFIG = { "bundle": \(InstaWeb.rulesJSON), "settings": {}, "telemetry": false };
        \(InstaWeb.engineSource)
        """
        var useEngine = true
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "debug.noEngine") { useEngine = false }
        #endif
        if useEngine {
            content.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        content.addUserScript(WKUserScript(source: InstaWeb.privacyHookSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addUserScript(WKUserScript(source: "window.__FOLLOWING_TAB = '\(tab.title.lowercased())';\n" + InstaWeb.extrasSource,
                                           injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        let cfg = WKWebViewConfiguration()
        cfg.userContentController = content
        cfg.websiteDataStore = InstaWeb.dataStore
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        // Videos can go into Picture in Picture (the PiP button on videos in the Home feeds).
        cfg.allowsPictureInPictureMediaPlayback = true

        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.allowsBackForwardNavigationGestures = true
        super.init()

        content.add(MessageProxy(self), name: "following")
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        #if DEBUG
        DebugHooks.attach(self)
        #endif
    }

    func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        loadStart()
    }

    func loadStart() {
        loaded = true
        webView.load(URLRequest(url: tab.startURL))
    }

    func reloadIfSignedOut() {
        guard loaded, let path = webView.url?.path else { return }
        if path.hasPrefix("/accounts/login") || path.hasPrefix("/accounts/emailsignup") {
            loadStart()
        }
    }

    @objc private func pullToRefresh(_ sender: UIRefreshControl) {
        webView.reload()
        onRefresh?()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { sender.endRefreshing() }
    }

    fileprivate func receive(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return }
        if type == "username", let user = dict["value"] as? String,
           user.range(of: "^[A-Za-z0-9._]{1,30}$", options: .regularExpression) != nil {
            UserDefaults.standard.set(user, forKey: InstaWeb.usernameKey)
            return
        }
        onMessage?(type, dict["value"])
    }

    private func openOutside(_ url: URL) {
        guard let root = webView.window?.rootViewController else { return }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        let safari = SFSafariViewController(url: url)
        safari.dismissButtonStyle = .close
        top.present(safari, animated: true)
    }
}

extension InstaWebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }

        // instagram:// and other app links would throw you into the real app.
        if let scheme = url.scheme?.lowercased(), !["http", "https", "about", "data", "blob"].contains(scheme) {
            decisionHandler(.cancel); return
        }
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        if mainFrame, !InstaWeb.staysInApp(url) {
            decisionHandler(.cancel)
            openOutside(url)
            return
        }
        decisionHandler(.allow)
    }

    /// iOS can kill a background web view to save memory; reload instead of sitting blank.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    #if DEBUG
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DebugHooks.log("\(tab.title) finished \(webView.url?.absoluteString ?? "?")")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        DebugHooks.log("\(tab.title) failed \(error)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DebugHooks.log("\(tab.title) failed provisional \(error)")
    }
    #endif
}

extension InstaWebController: WKUIDelegate {
    /// Links that ask for a new window open in the same tab.
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, navigationAction.targetFrame == nil {
            if InstaWeb.staysInApp(url) { webView.load(URLRequest(url: url)) } else { openOutside(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.prompt)
    }
}

/// WKUserContentController keeps a strong reference to its handler; this proxy
/// breaks the cycle with the controller.
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: InstaWebController?
    init(_ target: InstaWebController) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        Task { @MainActor in self.target?.receive(body) }
    }
}

/// Puts a tab's web view on screen.
struct InstaWebView: UIViewRepresentable {
    let controller: InstaWebController

    func makeUIView(context: Context) -> WKWebView {
        controller.loadIfNeeded()
        return controller.webView
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
