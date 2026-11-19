import SwiftUI

/// The app's own settings (the pane opened from the Following icon on your profile). Kept in
/// UserDefaults and passed to every page as `window.__FL` (extras.js reads it with S("key")).
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    enum Appearance: String, CaseIterable, Identifiable {
        case system, light, dark
        var id: String { rawValue }
        var title: String {
            switch self {
            case .system: return "System default"
            case .light: return "Light"
            case .dark: return "Dark"
            }
        }
        var scheme: ColorScheme? {
            switch self {
            case .system: return nil
            case .light: return .light
            case .dark: return .dark
            }
        }
    }

    struct Item: Identifiable {
        let key: String
        let title: String
        let detail: String
        /// On for a new install (most are).
        var defaultOn = true
        var id: String { key }
    }

    /// The switches, in sections. On by default unless marked (All feed and Grayscale are off,
    /// Appearance follows the phone).
    static let sections: [(title: String, items: [Item])] = [
        ("Home feed", [
            Item(key: "allFeed", title: "All feed", detail: "A third tab next to Following: Instagram's regular feed, suggested posts included.", defaultOn: false),
            Item(key: "storyCount", title: "\"Stories seen\" counter", detail: ""),
            Item(key: "bios", title: "Bios next to names", detail: "For private accounts, and public ones under the limit below."),
            Item(key: "oldDates", title: "Red dates on older posts", detail: "Bold red date on posts at least this many days old."),
            Item(key: "foldEarlier", title: "Auto-collapse earlier posts", detail: "When you're caught up at the top, older posts stay hidden until you tap View earlier posts."),
            Item(key: "hideLikedEarlier", title: "Don't show posts you've already liked", detail: "Below the caught-up checkmark."),
        ]),
        ("Search", [
            Item(key: "searchHidesExplore", title: "Search hides Explore", detail: "Search opens straight to the search box, with no Explore grid."),
        ]),
        ("Haptic Vibrations", [
            Item(key: "hapticTabs", title: "Haptic on tab switch", detail: ""),
            Item(key: "hapticCheck", title: "Haptic on caught-up checkmark", detail: ""),
        ]),
    ]
    // Always on, no switch: the unread chats badge, the 2× speed button, the simpler Share sheet,
    // the app look for your profile, and the update banner.


    @Published var appearance: Appearance { didSet { save() } }
    @Published var grayscale: Bool { didSet { save() } }
    @Published var bioLimit: Int { didSet { save() } }
    /// Red dates from this many days old.
    @Published var oldDays: Int { didSet { save() } }
    /// The Home feed the app opens on: "friends" or "following".
    @Published var defaultFeed: String { didSet { save() } }
    @Published private(set) var switches: [String: Bool]

    /// Accounts muted from this app (a post's menu, or a profile's menu), for Muted accounts.
    struct MutedAccount: Codable, Identifiable, Equatable {
        let id: String
        var username: String
    }
    @Published private(set) var mutedAccounts: [MutedAccount] = []
    /// Unmutes an account through Instagram (set by the app: it runs in the Home page).
    var unmuter: ((String) async -> Bool)?

    func setMuted(id: String, username: String, muted: Bool) {
        mutedAccounts.removeAll { $0.id == id }
        if muted { mutedAccounts.insert(MutedAccount(id: id, username: username), at: 0) }
        if let data = try? JSONEncoder().encode(mutedAccounts) { d.set(data, forKey: "settings.mutedAccounts") }
    }

    /// Something changed since the pane opened (pages are reloaded when it closes).
    private(set) var changed = false

    private let d = UserDefaults.standard

    private init() {
        appearance = Appearance(rawValue: d.string(forKey: "settings.appearance") ?? "") ?? .system
        grayscale = d.bool(forKey: "settings.grayscale")
        bioLimit = d.object(forKey: "settings.bioLimit") as? Int ?? 4000
        oldDays = d.object(forKey: "settings.oldDays") as? Int ?? 3
        defaultFeed = d.string(forKey: "settings.defaultFeed") == "following" ? "following" : "friends"
        var s: [String: Bool] = [:]
        for section in Self.sections {
            for item in section.items {
                s[item.key] = d.object(forKey: "settings." + item.key) as? Bool ?? item.defaultOn
            }
        }
        // Switches that live on a row of their own (not in `sections`).
        s["bioPublic"] = d.object(forKey: "settings.bioPublic") as? Bool ?? true
        switches = s
        if let data = d.data(forKey: "settings.mutedAccounts"),
           let list = try? JSONDecoder().decode([MutedAccount].self, from: data) { mutedAccounts = list }
    }

    func isOn(_ key: String) -> Bool { switches[key] ?? true }

    func binding(_ key: String) -> Binding<Bool> {
        Binding(get: { self.isOn(key) }, set: { self.switches[key] = $0; self.save() })
    }

    private func save() {
        d.set(appearance.rawValue, forKey: "settings.appearance")
        d.set(grayscale, forKey: "settings.grayscale")
        d.set(bioLimit, forKey: "settings.bioLimit")
        d.set(oldDays, forKey: "settings.oldDays")
        d.set(defaultFeed, forKey: "settings.defaultFeed")
        for (k, v) in switches { d.set(v, forKey: "settings." + k) }
        changed = true
    }

    func markSeen() { changed = false }

    /// The NoScroll engine's own switches (its Explore rules follow "Search hides Explore").
    var engineSettingsJSON: String {
        isOn("searchHidesExplore") ? "{}" :
            "{\"instagram.explore-route\": false, \"instagram.explore-tab\": false, \"instagram.search-grid\": false}"
    }

    /// What the pages read: `window.__FL = {...}`.
    var pageScript: String {
        var obj: [String: Any] = switches
        obj["bioLimit"] = bioLimit
        obj["oldDays"] = oldDays
        obj["defaultFeed"] = defaultFeed
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{}".utf8)
        return "window.__FL = \(String(data: data, encoding: .utf8) ?? "{}");"
    }
}

/// Grayscale and Appearance on a view, following the settings the moment they change. Used on
/// the app itself and on each full-screen layer above it (the settings pane, the refresh guide),
/// since a layer above doesn't pick up what's set on the app beneath it.
struct FollowsLook: ViewModifier {
    @ObservedObject var settings = AppSettings.shared

    func body(content: Content) -> some View {
        content
            .overlay {
                if settings.grayscale {
                    Color.black.blendMode(.saturation).allowsHitTesting(false).ignoresSafeArea()
                }
            }
            .preferredColorScheme(settings.appearance.scheme)
    }
}

extension View {
    func followsLook() -> some View { modifier(FollowsLook()) }
}

/// Whether the settings pane is showing (the Following icon on your profile posts "showSettings").
@MainActor
final class SettingsPane: ObservableObject {
    static let shared = SettingsPane()
    @Published var show = false
}

struct SettingsView: View {
    @ObservedObject var settings = AppSettings.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Appearance", selection: $settings.appearance) {
                        ForEach(AppSettings.Appearance.allCases) { Text($0.title).tag($0) }
                    }
                    Toggle("Grayscale", isOn: $settings.grayscale)
                }
                Section {
                    NavigationLink {
                        MutedAccountsView()
                    } label: {
                        HStack {
                            Text("Muted accounts")
                            Spacer()
                            Text("\(settings.mutedAccounts.count)").foregroundStyle(.secondary)
                        }
                    }
                }
                ForEach(AppSettings.sections, id: \.title) { section in
                    Section(section.title) {
                        if section.title == "Home feed" {
                            Picker("Default feed", selection: $settings.defaultFeed) {
                                Text("Friends").tag("friends")
                                Text("Following").tag("following")
                            }
                        }
                        ForEach(section.items) { item in
                            if item.key == "oldDates" {
                                // On the same line: how many days, then the switch.
                                HStack(spacing: 10) {
                                    label(item.title, item.detail)
                                    Spacer(minLength: 4)
                                    TextField("3", value: $settings.oldDays, format: .number)
                                        .keyboardType(.numberPad)
                                        .multilineTextAlignment(.center)
                                        .frame(width: 44)
                                        .padding(.vertical, 4)
                                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                                        .disabled(!settings.isOn("oldDates"))
                                        .opacity(settings.isOn("oldDates") ? 1 : 0.4)
                                    Text("days").foregroundStyle(.secondary)
                                    Toggle("", isOn: settings.binding(item.key)).labelsHidden()
                                }
                            } else {
                                Toggle(isOn: settings.binding(item.key)) { label(item.title, item.detail) }
                            }
                            if item.key == "bios" {
                                // Public accounts: bios only under this many followers (or none).
                                let on = settings.isOn("bios") && settings.isOn("bioPublic")
                                HStack(spacing: 10) {
                                    Text("Public accounts under")
                                    Spacer(minLength: 4)
                                    TextField("4000", value: $settings.bioLimit, format: .number)
                                        .keyboardType(.numberPad)
                                        .multilineTextAlignment(.center)
                                        .frame(width: 64)
                                        .padding(.vertical, 4)
                                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
                                        .disabled(!on)
                                        .opacity(on ? 1 : 0.4)
                                    Text("followers").foregroundStyle(.secondary)
                                    Toggle("", isOn: settings.binding("bioPublic")).labelsHidden()
                                }
                                .disabled(!settings.isOn("bios"))
                                .opacity(settings.isOn("bios") ? 1 : 0.5)
                            }
                        }
                    }
                }
            }
            .navigationTitle("App settings")
            // Follows Appearance right away (the pane is its own layer above the app).
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.backward").font(.system(size: 17, weight: .semibold))
                            Text("Back").font(.system(size: 17, weight: .semibold))
                        }
                        .foregroundStyle(RefreshGuideView.instagramPurple)
                    }
                }
            }
        }
        .followsLook()
    }

    private func label(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(.secondary) }
        }
    }
}

/// Accounts muted from this app, each with an Unmute button (Instagram's own unmute, posts and
/// stories).
struct MutedAccountsView: View {
    @ObservedObject var settings = AppSettings.shared
    @State private var busy: Set<String> = []
    @State private var failed: Set<String> = []

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("What muting does").font(.headline)
                    Text("Their posts and stories stop showing in your feed and story row, here and in the Instagram app. You still follow them, they aren't told, and you can still see everything by opening their profile. Unmute any time.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 2)
            }
            Section {
            if settings.mutedAccounts.isEmpty {
                Text("No muted accounts. Mute someone from the menu on their post, or the ... menu on their profile.")
                    .foregroundStyle(.secondary)
            }
            ForEach(settings.mutedAccounts) { account in
                HStack {
                    Text("@" + account.username)
                    Spacer()
                    if busy.contains(account.id) {
                        ProgressView()
                    } else {
                        Button(failed.contains(account.id) ? "Try again" : "Unmute") { unmute(account) }
                            .buttonStyle(.bordered)
                    }
                }
            }
            }
        }
        .navigationTitle("Muted accounts")
        .navigationBarTitleDisplayMode(.inline)
        .followsLook()
    }

    private func unmute(_ account: AppSettings.MutedAccount) {
        busy.insert(account.id)
        failed.remove(account.id)
        Task {
            let ok = await settings.unmuter?(account.id) ?? false
            busy.remove(account.id)
            if ok { settings.setMuted(id: account.id, username: account.username, muted: false) } else { failed.insert(account.id) }
        }
    }
}
