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

    /// Instagram's "you're leaving Instagram" redirect (l.instagram.com/?u=...), used by link
    /// stickers on stories and links in bios: the real address it leads to.
    static func outboundTarget(_ url: URL) -> URL? {
        guard let host = url.host?.lowercased(), host == "l.instagram.com" || host == "l.facebook.com",
              let u = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "u" })?.value,
              let target = URL(string: u), ["http", "https"].contains(target.scheme?.lowercased() ?? "") else { return nil }
        return target
    }

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
    /// Called when a page this browser loads starts to show (the first paint is coming).
    var onCommit: (() -> Void)?
    private let content: WKUserContentController

    /// The page scripts: the app's settings (window.__FL), the NoScroll engine and privacy hook at
    /// document start, extras.js at document end.
    private static func installScripts(_ content: WKUserContentController, tab: InstaTab) {
        content.removeAllUserScripts()
        content.addUserScript(WKUserScript(source: AppSettings.shared.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // The engine runs at document start so hidden parts never paint.
        let bootstrap = """
        window.__NOSCROLL_CONFIG = { "bundle": \(InstaWeb.rulesJSON), "settings": \(AppSettings.shared.engineSettingsJSON), "telemetry": false };
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
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
            .filter { $0.isNumber || $0 == "." }
        content.addUserScript(WKUserScript(source: "window.__FOLLOWING_TAB = '\(tab.title.lowercased())';\nwindow.__FOLLOWING_VERSION = '\(version)';\n" + InstaWeb.extrasSource,
                                           injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    /// Settings changed: new scripts for the next load, and reload what's showing.
    func applySettings() {
        Self.installScripts(content, tab: tab)
        guard loaded else { return }
        webView.reload()
    }

    init(tab: InstaTab) {
        self.tab = tab

        let content = WKUserContentController()
        self.content = content
        Self.installScripts(content, tab: tab)

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

    /// Open an address in this tab. Counts as its first load, so the tab doesn't replace it with
    /// its start page when it first appears.
    func open(_ url: URL) {
        loaded = true
        webView.load(URLRequest(url: url))
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
        onRefresh?()
        // Also look for a newer build on GitHub (about 1 KB).
        NotificationCenter.default.post(name: RefreshReminder.checkNow, object: nil)
        refreshOrReload { [weak sender] quick in
            // A quick refresh ends the spinner when the new posts are in ("refreshed" below).
            if !quick { DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { sender?.endRefreshing() } }
        }
        // Never spin forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak sender] in sender?.endRefreshing() }
    }

    /// The Home feeds refresh in place (extras.js, window.__flRefresh): one request, the current
    /// posts stay up until the new ones arrive. Anything else, or if the page isn't ready, reloads.
    func refreshOrReload(_ completion: ((Bool) -> Void)? = nil) {
        webView.evaluateJavaScript("window.__flRefresh ? window.__flRefresh() : false") { [weak self] result, _ in
            let quick = (result as? Bool) == true || (result as? NSNumber)?.boolValue == true
            #if DEBUG
            DebugHooks.log("refreshOrReload result=\(String(describing: result)) quick=\(quick)")
            #endif
            if !quick { self?.webView.reload() }
            completion?(quick)
        }
    }

    fileprivate func receive(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return }
        if type == "username", let user = dict["value"] as? String,
           user.range(of: "^[A-Za-z0-9._]{1,30}$", options: .regularExpression) != nil {
            UserDefaults.standard.set(user, forKey: InstaWeb.usernameKey)
            return
        }
        if type == "profilePic", let address = dict["value"] as? String {
            ProfilePic.shared.update(from: address)
            return
        }
        if type == "haptic" {
            let on = AppSettings.shared
            if (dict["value"] as? String) == "like" {
                // Liking a post or a story.
                guard on.isOn("hapticLikes") else { return }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } else if (dict["value"] as? String) == "tap" {
                guard on.isOn("hapticTabs") else { return }
                // Switching between Friends and Following: the tab bar's light tap.
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } else {
                // The "success" tap as the caught-up check finishes drawing.
                guard on.isOn("hapticCheck") else { return }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
            return
        }
        if type == "muted", let v = dict["value"] as? [String: Any],
           let id = v["id"] as? String, let name = v["username"] as? String {
            AppSettings.shared.setMuted(id: id, username: name, muted: (v["muted"] as? Bool) ?? false)
            return
        }
        if type == "showSettings" {
            SettingsPane.shared.show = true
            return
        }
        if type == "showGuide" {
            Guide.shared.show = true
            return
        }
        if type == "dmBadge" {
            DMBadge.shared.count = (dict["value"] as? Int) ?? (dict["value"] as? NSNumber)?.intValue ?? 0
            return
        }
        if type == "refreshed" {
            webView.scrollView.refreshControl?.endRefreshing()
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
        // A link sticker or bio link: straight to the website, in a Safari sheet.
        if mainFrame, let target = InstaWeb.outboundTarget(url) {
            decisionHandler(.cancel)
            openOutside(target)
            return
        }
        if mainFrame, !InstaWeb.staysInApp(url) {
            decisionHandler(.cancel)
            openOutside(url)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        onCommit?()
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
            if let target = InstaWeb.outboundTarget(url) {
                openOutside(target)
            } else if InstaWeb.staysInApp(url) { webView.load(URLRequest(url: url)) } else { openOutside(url) }
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

/// How many chats have something unread (Instagram's own count), for the red badge on the
/// Messages tab.
@MainActor
final class DMBadge: ObservableObject {
    static let shared = DMBadge()
    @Published var count = 0
}
