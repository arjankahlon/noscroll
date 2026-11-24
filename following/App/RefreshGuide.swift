import SwiftUI

/// Whether the "How to refresh" page is showing. Opened by the (i) next to the version above the
/// stories (extras.js posts "showGuide") and by the (i) on the orange banner.
@MainActor
final class Guide: ObservableObject {
    static let shared = Guide()
    @Published var show = false
    /// Feedback: changes each time it's tapped; the app then opens a chat with the author in the
    /// Messages tab (inside Following, never the Instagram app).
    @Published var feedbackRequest = 0
    static let feedbackURL = URL(string: "https://www.instagram.com/arjan.kahlon/?fl_dm=1")!
}

/// "Following v1.x by Arjan Kahlon" and a Feedback button, which closes the page it's on and
/// opens a chat with the author in Messages. On the refresh guide and at the top of App settings.
struct FeedbackLine: View {
    /// Closes the page the line is on.
    let close: () -> Void

    private var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    }

    var body: some View {
        HStack(spacing: 6) {
            Text("Following v\(version) by Arjan Kahlon")
            Button {
                close()
                Guide.shared.feedbackRequest += 1
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "message.fill").font(.system(size: 13))
                    Text("Feedback")
                }
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(Capsule().stroke(Color.blue, lineWidth: 1.2))
            }
            .buttonStyle(.plain)
        }
        .font(.system(size: 17))
        .foregroundStyle(.blue)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// One screen, no scrolling: how to keep Following (and SideStore itself) from expiring.
/// The pictures are simple drawings of what you tap, not screenshots.
struct RefreshGuideView: View {
    @ObservedObject var reminder: RefreshReminder
    @ObservedObject private var settings = AppSettings.shared
    @Environment(\.dismiss) private var dismiss

    /// Instagram's purple, for the Back button.
    static let instagramPurple = Color(red: 0.51, green: 0.23, blue: 0.71)

    private var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { dismiss() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.backward").font(.system(size: 17, weight: .semibold))
                    Text("Back").font(.system(size: 17, weight: .semibold))
                }
                .foregroundStyle(Self.instagramPurple)
            }
            .padding(.bottom, 10)

            FeedbackLine { dismiss() }
                .padding(.bottom, 12)

            Text("Refresh the app")
                .font(.system(size: 28, weight: .bold))
            Text("Apps installed with SideStore stop opening after 7 days. Refresh before then.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .padding(.top, 4)
            if !reminder.expiryText.isEmpty {
                Text("This copy: \(reminder.expiryText)")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.orange)
                    .padding(.top, 4)
            }

            VStack(alignment: .leading, spacing: 14) {
                step(1, Text("Turn on LocalDevVPN"), opens: Self.vpnOn) { vpnPicture }
                step(2, HStack(spacing: 6) {
                    Text("Open")
                    Image("SideStoreLogo").resizable().frame(width: 22, height: 22)
                        .clipShape(RoundedRectangle(cornerRadius: 5))
                    Text("SideStore, then My Apps")
                }, opens: Self.sideStore) {
                    picture("GuideMyAppsTab")
                }
                step(3, Text("Tap Refresh All"), detail: "Renews SideStore and Following together. If Following says Update, tap that too.") {
                    picture("GuideRefreshAll").frame(maxHeight: 165)
                }
                step(4, Text("When it's done, turn off LocalDevVPN"), opens: Self.vpnOff) { EmptyView() }
            }
            .padding(.top, 16)

            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                (Text("Always use ") + Text("Refresh All").bold().foregroundColor(Self.instagramPurple)
                    + Text(", not just Following. If SideStore itself expires, nothing can be refreshed until SideStore is reinstalled from a computer."))
                    .font(.system(size: 14))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 16)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(.systemBackground))
        .followsLook()
    }

    /// A cropped screenshot of SideStore.
    private func picture(_ name: String) -> some View {
        Image(name)
            .resizable()
            .scaledToFit()
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    /// Tapping steps 1 and 4 opens LocalDevVPN and switches it on or off (its own links); step 2
    /// opens SideStore.
    static let vpnOn = URL(string: "localdevvpn://enable")!
    static let vpnOff = URL(string: "localdevvpn://disable")!
    static let sideStore = URL(string: "sidestore://")!

    private func step<T: View, P: View>(_ n: Int, _ title: T, detail: String? = nil, opens: URL? = nil, @ViewBuilder picture: () -> P) -> some View {
        stepBody(n, title, detail: detail, picture: picture)
            .contentShape(Rectangle())
            .onTapGesture { if let opens { UIApplication.shared.open(opens) } }
    }

    private func stepBody<T: View, P: View>(_ n: Int, _ title: T, detail: String?, @ViewBuilder picture: () -> P) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.primary))
            VStack(alignment: .leading, spacing: 8) {
                title.font(.system(size: 17, weight: .semibold))
                if let detail {
                    Text(detail).font(.system(size: 14)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                picture()
            }
        }
    }

    // MARK: Pictures

    private var vpnPicture: some View {
        HStack(spacing: 10) {
            Image("LocalDevVPNLogo").resizable()
                .frame(width: 30, height: 30)
                .clipShape(RoundedRectangle(cornerRadius: 7))
            Text("LocalDevVPN").font(.system(size: 15, weight: .medium))
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(.green).frame(width: 8, height: 8)
                Text("Connected").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

}
