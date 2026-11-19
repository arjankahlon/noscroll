import SwiftUI
import UIKit

/// The orange "refresh in SideStore" banner.
///
/// It also shows when a newer build is waiting: the app reads the SideStore source on GitHub
/// (following/source.json, about 2.5 KB, which each GitHub build updates) at most once every
/// 2 hours, never in the first 20 seconds after launch, and compares the newest build number there
/// with its own. The newest build it has seen is remembered, so the banner is back at once on the
/// next launch. Updating in SideStore installs the new build and re-signs it,
/// which clears both reasons for the banner.
///
/// SideStore (or AltStore) re-signs the app with your Apple ID; apps signed that way stop opening
/// after 7 days. Each re-sign puts a new provisioning profile inside the app
/// (embedded.mobileprovision) with the date it was made and the date it expires. The app reads it
/// at launch and whenever it comes back to the screen: from 5 days after the last re-sign, the
/// banner shows until SideStore re-signs the app again (a new profile resets the clock).
@MainActor
final class RefreshReminder: ObservableObject {
    @Published private(set) var show = false
    @Published private(set) var expires: Date?
    /// The newer version waiting in SideStore ("1.0.10"), if there is one.
    @Published private(set) var updateVersion: String?
    private var signingDue = false
    private let launched = Date()
    private static let lastCheckKey = "following.updateCheckedAt"
    private static let latestKey = "following.latestBuild"
    private static let latestVersionKey = "following.latestVersion"
    static let checkEvery: TimeInterval = 2 * 3600

    static let sourceURL = URL(string: "https://raw.githubusercontent.com/arjankahlon/noscroll/main/following/source.json")!

    static let remindAfterDays: Double = 5
    private var timer: Timer?

    init() {
        update()
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.update() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 1800, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.update() }
        }
    }

    func update() {
        // The newest build seen on GitHub before (no network needed).
        let d = UserDefaults.standard
        if let mine = Self.localBuild, d.integer(forKey: Self.latestKey) > mine {
            updateVersion = d.string(forKey: Self.latestVersionKey) ?? "1.0.\(d.integer(forKey: Self.latestKey))"
        } else {
            updateVersion = nil
        }
        if let profile = Self.signingDates() {
            expires = profile.expires
            signingDue = Date().timeIntervalSince(profile.created) >= Self.remindAfterDays * 86400
        } else {
            expires = nil
            signingDue = false
        }
        show = signingDue || updateVersion != nil
        checkForUpdate()
    }

    /// This copy's build number (the GitHub build it came from). Debug builds from the Mac are
    /// "1": they never ask (`defaults write com.arjankahlon.following debug.localBuild -int 5`
    /// pretends to be build 5, for testing).
    static var localBuild: Int? {
        #if DEBUG
        let fake = UserDefaults.standard.integer(forKey: "debug.localBuild")
        if fake > 0 { return fake }
        #endif
        guard let s = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              let n = Int(s), n > 1 else { return nil }
        return n
    }

    private func checkForUpdate() {
        guard let mine = Self.localBuild else { return }
        let d = UserDefaults.standard
        let last = d.object(forKey: Self.lastCheckKey) as? Date ?? .distantPast
        guard Date().timeIntervalSince(last) > Self.checkEvery else { return }
        // Not while the app is starting up: try again once the feed has had time to load.
        let wait = 20 - Date().timeIntervalSince(launched)
        if wait > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + wait + 0.5) { [weak self] in self?.checkForUpdate() }
            return
        }
        d.set(Date(), forKey: Self.lastCheckKey)
        var request = URLRequest(url: Self.sourceURL)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let app = (json["apps"] as? [[String: Any]])?.first,
                  let latest = (app["versions"] as? [[String: Any]])?.first,
                  let build = Int(latest["buildVersion"] as? String ?? "") else { return }
            let version = latest["version"] as? String ?? "1.0.\(build)"
            Task { @MainActor in
                guard let self else { return }
                UserDefaults.standard.set(build, forKey: Self.latestKey)
                UserDefaults.standard.set(version, forKey: Self.latestVersionKey)
                self.updateVersion = build > mine ? version : nil
                self.show = self.signingDue || self.updateVersion != nil
            }
        }.resume()
    }

    /// The banner's line: a new build, or the 7-day signing clock.
    var bannerTitle: String {
        updateVersion != nil ? "LocalDevVPN → Update in SideStore" : "LocalDevVPN → Refresh in SideStore"
    }

    var bannerDetail: String {
        if let v = updateVersion { return "v\(v) ready" }
        return expiryText
    }

    /// "Expires in 2 days", "Expires today", "Expired".
    var expiryText: String {
        guard let expires else { return "" }
        let hours = expires.timeIntervalSinceNow / 3600
        if hours <= 0 { return "expired" }
        if hours < 24 { return "expires today" }
        let days = Int((hours / 24).rounded(.down))
        return days == 1 ? "1 day left" : "\(days) days left"
    }

    /// The creation and expiry dates of the profile SideStore signed this copy with. None in the
    /// Simulator or in a copy installed from Xcode without a profile.
    static func signingDates() -> (created: Date, expires: Date)? {
        #if DEBUG
        // Debugging: `defaults write com.arjankahlon.following debug.signedDaysAgo -float 6`
        let fake = UserDefaults.standard.double(forKey: "debug.signedDaysAgo")
        if fake > 0 {
            let created = Date().addingTimeInterval(-fake * 86400)
            return (created, created.addingTimeInterval(7 * 86400))
        }
        #endif
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let start = text.range(of: "<?xml"),
              let end = text.range(of: "</plist>"),
              let plist = try? PropertyListSerialization.propertyList(
                  from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
              let created = plist["CreationDate"] as? Date,
              let expires = plist["ExpirationDate"] as? Date
        else { return nil }
        return (created, expires)
    }
}

/// A slim orange strip under the status bar: one centred line.
struct RefreshBanner: View {
    @ObservedObject var reminder: RefreshReminder

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 14, weight: .bold))
            Text(reminder.bannerTitle)
                .font(.system(size: 15, weight: .semibold))
            Text("· \(reminder.bannerDetail)")
                .font(.system(size: 15, weight: .regular))
                .opacity(0.85)
        }
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Color.orange.ignoresSafeArea(edges: .top))
        .accessibilityElement(children: .combine)
    }
}
