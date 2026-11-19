import SwiftUI
import UIKit
import WebKit

/// The story strip above the Following feed.
///
/// Instagram's web Following page has no stories. So a second, small browser loads Instagram's
/// For You page, where extras.js hides everything except Instagram's own story row (section 6).
/// This keeps Instagram's own order and its own story viewer, which moves on from one person to
/// the next.
///
/// Collapsed, the strip lives inside the Following feed's own scroll view, over a gap that
/// extras.js leaves at the top of the page, so it scrolls with the feed natively (no per-frame
/// updates). While a story or a profile opened from it is showing, it moves to a full-screen
/// layer above the tabs (StoriesLayer).
@MainActor
final class StoriesModel: ObservableObject {
    /// A story (or a profile opened from one) is showing: the strip fills the screen.
    @Published private(set) var expanded = false
    /// The full-screen layer is showing a story (Instagram's viewer has its own close button).
    /// Otherwise it is a profile or post opened from a story, and the app shows a back button.
    @Published private(set) var onStoryPage = false
    /// A post or profile tapped in the feed is loading: the layer shows at once, with a spinner,
    /// instead of nothing happening for a couple of seconds.
    @Published private(set) var opening = false
    /// Back on the story row: Instagram's whole page shows for a moment before extras.js trims
    /// it to the row, so the row stays hidden until the page says it's ready ("stripReady").
    private var awaitingRow = false
    private var awaitingTimer: Timer?
    /// "Stories: 12/80 seen", passed on to the Home feed for under "You're all caught up".
    private var storyCount = ""

    /// Height of Instagram's story row, measured by the page. 0 until it has loaded.
    private var height: CGFloat = 0
    private var homeOnFeed = true
    private var observers: [NSKeyValueObservation] = []
    private weak var home: InstaWebController?
    private weak var strip: InstaWebController?
    /// The full-screen layer's view, while it exists.
    weak var layerView: UIView? { didSet { place() } }

    func attach(home: InstaWebController, strip: InstaWebController) {
        guard observers.isEmpty else { return }
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "debug.noStrip") { return }
        #endif
        self.home = home
        self.strip = strip

        let sv = strip.webView.scrollView
        sv.isScrollEnabled = false
        sv.bounces = false
        sv.refreshControl = nil
        strip.webView.isHidden = true
        strip.loadIfNeeded()

        strip.onCommit = { [weak self] in
            guard let self, self.opening else { return }
            self.opening = false
            self.place()
        }
        strip.onMessage = { [weak self] type, value in
            guard let self else { return }
            if type == "stripReady" { self.rowReady(); return }
            // Pulled down on the story row (which keeps the drag): refresh Home, spinner included.
            if type == "pullRefresh" { self.pullRefresh(); return }
            if type == "storyCount", let text = value as? String {
                self.storyCount = text
                self.pushStoryCount()
                return
            }
            // Saved or unsaved a post from the feed's bookmark: back to the feed.
            if type == "closeOverlay" { if self.expanded { self.back() }; return }
            guard type == "trayHeight", let h = value as? Double, h > 0 else { return }
            if abs(CGFloat(h) - self.height) > 0.5 {
                self.height = CGFloat(h)
                self.pushHeight()
                self.place()
            }
        }
        home.onRefresh = { [weak strip] in strip?.webView.reload() }
        // The Friends feed opens posts, profiles and comments full screen over the feed.
        home.onMessage = { [weak self] type, value in
            guard type == "openOverlay", let s = value as? String, let url = URL(string: s),
                  url.scheme == "https", url.host?.hasSuffix("instagram.com") == true else { return }
            self?.open(url)
        }

        observers.append(home.webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
            let onFeed = Self.isFollowingFeed(wv.url)
            Task { @MainActor in
                guard let self else { return }
                self.homeOnFeed = onFeed
                if onFeed { self.pushHeight() }
                self.place()
            }
        })
        observers.append(home.webView.observe(\.isLoading, options: [.new]) { [weak self] wv, _ in
            guard !wv.isLoading else { return }
            Task { @MainActor in self?.pushHeight(); self?.pushStoryCount() }
        })
        observers.append(strip.webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
            #if DEBUG
            DebugHooks.log("strip url \(wv.url?.absoluteString ?? "nil")")
            #endif
            // Anything other than the strip's own page (a story, or a profile opened from one)
            // is shown full screen.
            let open = !(wv.url?.path == "/" || wv.url?.path.isEmpty == true)
            let story = wv.url?.path.hasPrefix("/stories/") ?? false
            Task { @MainActor in
                guard let self else { return }
                if self.onStoryPage != story { self.onStoryPage = story }
                // Still on the row while a tapped post or profile starts loading: stay open.
                if self.opening && !open { return }
                guard self.expanded != open else { return }
                self.expanded = open
                if !open { self.waitForRow() }
                self.place()
            }
        })
        place()
    }

    /// Open a post, profile or comments from the feed full screen.
    func open(_ url: URL) {
        guard let strip else { return }
        opening = true
        expanded = true
        place()
        strip.webView.load(URLRequest(url: url))
        // Never spin forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, self.opening else { return }
            self.opening = false
            self.place()
        }
    }

    /// Hide the row until the page has trimmed itself to it (or 3 seconds pass).
    private func waitForRow() {
        awaitingRow = true
        awaitingTimer?.invalidate()
        awaitingTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.rowReady() }
        }
    }

    private func rowReady() {
        awaitingTimer?.invalidate()
        awaitingTimer = nil
        guard awaitingRow else { return }
        awaitingRow = false
        place()
    }

    /// The back button over a profile or post opened from a story.
    func back() {
        guard let strip else { return }
        // Still loading what was tapped: cancel it and go back to the row.
        if opening {
            opening = false
            strip.webView.stopLoading()
            expanded = false
            waitForRow()
            place()
            strip.loadStart()
            return
        }
        // Back to a story (you opened the profile from it): let Instagram go back.
        // Back to the story row itself, or nothing to go back to: reload the row cleanly.
        if let previous = strip.webView.backForwardList.backItem, previous.url.path != "/", !previous.url.path.isEmpty {
            strip.webView.goBack()
        } else {
            strip.loadStart()
        }
    }

    /// Put the strip where it belongs: in the feed's scroll view, or in the full-screen layer.
    private func place() {
        guard let strip, let home else { return }
        let wv = strip.webView
        if expanded, let layer = layerView {
            if wv.superview !== layer {
                wv.removeFromSuperview()
                layer.addSubview(wv)
            }
            wv.frame = layer.bounds
            wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            wv.scrollView.isScrollEnabled = true
            wv.isHidden = opening
        } else {
            let sv = home.webView.scrollView
            if wv.superview !== sv {
                wv.removeFromSuperview()
                sv.addSubview(wv)
            }
            wv.autoresizingMask = [.flexibleWidth]
            wv.frame = CGRect(x: 0, y: 0, width: home.webView.bounds.width, height: max(height, 120))
            wv.scrollView.isScrollEnabled = false
            wv.scrollView.contentOffset = .zero
            wv.isHidden = !(homeOnFeed && height > 0) || awaitingRow
        }
    }

    private func pullRefresh() {
        guard !expanded, homeOnFeed, let home else { return }
        let feed = home.webView.scrollView
        guard let control = feed.refreshControl, !control.isRefreshing,
              feed.contentOffset.y <= -feed.adjustedContentInset.top + 2 else { return }
        control.beginRefreshing()
        feed.setContentOffset(CGPoint(x: 0, y: -feed.adjustedContentInset.top - control.frame.height), animated: true)
        control.sendActions(for: .valueChanged)
    }

    private func pushStoryCount() {
        guard !storyCount.isEmpty, let home else { return }
        let js = "window.__flSetStoryCount && window.__flSetStoryCount(\(Self.jsString(storyCount)))"
        home.webView.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }

    /// Tell the Following feed how tall a gap to leave for the strip.
    private func pushHeight() {
        guard height > 0, let home else { return }
        home.webView.evaluateJavaScript(
            "document.documentElement.style.setProperty('--fl-tray', '\(Int(height))px')",
            completionHandler: nil)
    }

    static func isFollowingFeed(_ url: URL?) -> Bool {
        guard let url, url.path == "/" || url.path.isEmpty else { return false }
        return (url.query ?? "").contains("variant=following")
    }
}

/// The full-screen layer a story (or a profile opened from it) shows in.
struct StoriesLayer: UIViewRepresentable {
    let model: StoriesModel

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .systemBackground
        DispatchQueue.main.async { model.layerView = v }
        return v
    }

    func updateUIView(_ view: UIView, context: Context) {
        if model.layerView !== view { DispatchQueue.main.async { model.layerView = view } }
    }
}

