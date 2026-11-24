import SwiftUI
import WebKit

/// Muted accounts, as Instagram has them (so every phone shows the same list, including accounts
/// muted in the Instagram app or on another phone). Instagram builds its Muted accounts page on its
/// own servers, so the app loads that page in an invisible browser and reads the list off it, then
/// looks up each account's id from their profile page (for Unmute).
@MainActor
final class MutedSync: ObservableObject {
    static let shared = MutedSync()
    @Published private(set) var syncing = false
    private var web: WKWebView?
    private var lastSync = Date.distantPast

    /// Reads the list once it's on the page; "" while it isn't yet.
    private static let scrape = """
    var lines = document.body ? document.body.innerText.split('\\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    if (lines.indexOf('Muted accounts') === -1) return '';
    // Long lists load as you scroll.
    window.scrollTo(0, document.body.scrollHeight);
    var out = [];
    for (var i = 2; i < lines.length; i++) {
      if (lines[i] === 'View profile' && /muted$/i.test(lines[i - 1])) out.push({ u: lines[i - 2], what: lines[i - 1] });
    }
    for (var k = 0; k < out.length; k++) {
      try {
        // Their profile page names their id ("profilePage_123", "profile_id":"123").
        var html = await (await fetch('https://www.instagram.com/' + encodeURIComponent(out[k].u) + '/', { credentials: 'include' })).text();
        var m = /"page_id":"profilePage_(\\d+)"/.exec(html) || /"profile_id":"(\\d+)"/.exec(html);
        out[k].id = m ? m[1] : '';
      } catch (e) { out[k].id = ''; }
    }
    return JSON.stringify(out);
    """

    /// Fetch Instagram's list and make App settings match it. At most once a minute.
    func refresh(force: Bool = false) async {
        guard web == nil, force || Date().timeIntervalSince(lastSync) > 60 else { return }
        syncing = true
        defer { syncing = false; web = nil }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = InstaWeb.dataStore
        let w = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: cfg)
        web = w
        w.load(URLRequest(url: URL(string: "https://www.instagram.com/accounts/muted_accounts/")!))
        // Wait for the list to settle: the same answer twice in a row (it renders in steps).
        var last: String?
        var settled: String?
        var emptyReads = 0
        for _ in 0..<30 {
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard let s = try? await w.callAsyncJavaScript(Self.scrape, arguments: [:], contentWorld: .page) as? String,
                  !s.isEmpty else { continue }
            // The heading shows before the list does, so "nobody" only counts once the page has
            // stayed empty a while (5 reads, ~3.5 s): someone with no muted accounts isn't kept
            // waiting the full 21 s on every check.
            if s == "[]" {
                emptyReads += 1
                if emptyReads >= 5 { settled = s; break }
                last = last ?? s
                continue
            }
            emptyReads = 0
            if s == last { settled = s; break }
            last = s
        }
        guard let json = settled ?? last, let data = json.data(using: .utf8),
              let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { return }
        let list = rows.compactMap { r -> AppSettings.MutedAccount? in
            guard let u = r["u"], !u.isEmpty else { return nil }
            return AppSettings.MutedAccount(id: r["id"] ?? "", username: u, what: r["what"])
        }
        // An empty read never wipes a list that has accounts (a slow page once emptied it). If you
        // really unmuted everyone elsewhere, they leave the list as you unmute them here, or on the
        // next read that finds the page's list again.
        if list.isEmpty && !AppSettings.shared.mutedAccounts.isEmpty { return }
        lastSync = Date()
        AppSettings.shared.replaceMuted(list)
    }
}
