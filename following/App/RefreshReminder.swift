import SwiftUI
import UIKit

/// The orange "refresh in SideStore" banner.
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
        guard let profile = Self.signingDates() else { show = false; expires = nil; return }
        expires = profile.expires
        show = Date().timeIntervalSince(profile.created) >= Self.remindAfterDays * 86400
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
            Text("LocalDevVPN → Refresh in SideStore")
                .font(.system(size: 15, weight: .semibold))
            Text("· \(reminder.expiryText)")
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
