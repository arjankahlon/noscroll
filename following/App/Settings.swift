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
            Item(key: "storyCount", title: "\"Stories seen\" counter", detail: ""),
            Item(key: "offlineStories", title: "Allow offline stories", detail: "Load offline stories, above your stories. When off, the app's version shows there instead."),
            Item(key: "bios", title: "Bios next to names", detail: "For private accounts, and public ones under the limit below."),
            Item(key: "oldDates", title: "Red dates on older posts", detail: "Bold red date on posts at least this many days old."),
            Item(key: "hideLikedEarlier", title: "Don't show posts you've already liked", detail: "Below the caught-up checkmark."),
        ]),
        ("Search", [
            Item(key: "explorePage", title: "Enable Explore page", detail: "When off, the Search button goes straight to the search bar without showing the Explore page.", defaultOn: false),
        ]),
        ("Haptic Vibrations", [
            Item(key: "hapticTabs", title: "Haptic on tab switch", detail: ""),
            Item(key: "hapticCheck", title: "Haptic on caught-up checkmark", detail: ""),
            Item(key: "hapticLikes", title: "Haptic on likes", detail: ""),
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

    /// Muted accounts, as Instagram has them (MutedSync), plus any muted from this app since.
    struct MutedAccount: Codable, Identifiable, Equatable {
        let id: String
        var username: String
        /// "Posts muted", "Story muted", or both, as Instagram puts it.
        var what: String? = nil
    }
    @Published private(set) var mutedAccounts: [MutedAccount] = []
    /// Unmutes an account through Instagram (set by the app: it runs in the Home page).
    var unmuter: ((String) async -> Bool)?
    /// Mutes an account by username (posts, story) through Instagram, from the Home page.
    var muter: ((String, Bool, Bool) async -> Bool)?

    /// Instagram's own list (from MutedSync) replaces what's here.
    func replaceMuted(_ list: [MutedAccount]) {
        mutedAccounts = list
        if let data = try? JSONEncoder().encode(mutedAccounts) { d.set(data, forKey: "settings.mutedAccounts") }
    }

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
        let df = d.string(forKey: "settings.defaultFeed") ?? "friends"
        defaultFeed = ["friends", "following", "all"].contains(df) ? df : "friends"
        var s: [String: Bool] = [:]
        for section in Self.sections {
            for item in section.items {
                s[item.key] = d.object(forKey: "settings." + item.key) as? Bool ?? item.defaultOn
            }
        }
        // Switches that live on a row of their own (not in `sections`).
        s["bioPublic"] = d.object(forKey: "settings.bioPublic") as? Bool ?? true
        // The Home feeds (Customize feeds). All is off unless switched on.
        for f in Self.feeds { s[f.key] = d.object(forKey: "settings." + f.key) as? Bool ?? f.defaultOn }
        switches = s
        if let data = d.data(forKey: "settings.mutedAccounts"),
           let list = try? JSONDecoder().decode([MutedAccount].self, from: data) { mutedAccounts = list }
    }

    func isOn(_ key: String) -> Bool { switches[key] ?? true }

    /// The Home feeds, in their order at the top of Home.
    static let feeds: [(key: String, mode: String, title: String, detail: String, defaultOn: Bool)] = [
        ("feedFriends", "friends", "Friends", "Private accounts you follow, newest first", true),
        ("feedFollowing", "following", "Following", "Accounts you follow, in Instagram's suggested order", true),
        ("allFeed", "all", "All", "Instagram's regular feed with suggested posts", false),
    ]
    var enabledFeeds: [String] { Self.feeds.filter { isOn($0.key) }.map(\.mode) }

    /// A feed's switch. The last one on can't be switched off; switching off the default feed
    /// makes the first one still on the default.
    func feedBinding(_ key: String) -> Binding<Bool> {
        Binding(get: { self.isOn(key) }, set: { on in
            if !on && self.enabledFeeds.count <= 1 { return }
            self.switches[key] = on
            if !self.enabledFeeds.contains(self.defaultFeed), let first = self.enabledFeeds.first { self.defaultFeed = first }
            self.save()
        })
    }

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

    /// The NoScroll engine's own switches (its Explore rules follow "Enable Explore page").
    var engineSettingsJSON: String {
        !isOn("explorePage") ? "{}" :
            "{\"instagram.explore-route\": false, \"instagram.explore-tab\": false, \"instagram.search-grid\": false}"
    }

    /// What the pages read: `window.__FL = {...}`.
    var pageScript: String {
        var obj: [String: Any] = switches
        obj["bioLimit"] = bioLimit
        obj["oldDays"] = oldDays
        obj["defaultFeed"] = enabledFeeds.contains(defaultFeed) ? defaultFeed : (enabledFeeds.first ?? "friends")
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
                    FeedbackLine { dismiss() }
                    Picker("Appearance", selection: $settings.appearance) {
                        ForEach(AppSettings.Appearance.allCases) { Text($0.title).tag($0) }
                    }
                    Toggle("Grayscale", isOn: $settings.grayscale)
                }
                // A little closer to Muted accounts than the other sections are.
                .listSectionSpacing(24)
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
                            NavigationLink {
                                FeedsView()
                            } label: {
                                HStack {
                                    Text("Customize feeds")
                                    Spacer()
                                    Text(AppSettings.feeds.filter { settings.isOn($0.key) }.map(\.title).joined(separator: ", "))
                                        .foregroundStyle(.secondary)
                                }
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
            // Less empty space above the first block.
            .contentMargins(.top, 12, for: .scrollContent)
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

/// Customize feeds: which feeds Home has (Friends, Following, All), and which one it opens on.
struct FeedsView: View {
    @ObservedObject var settings = AppSettings.shared

    var body: some View {
        Form {
            Section {
                ForEach(AppSettings.feeds, id: \.key) { f in
                    Toggle(isOn: settings.feedBinding(f.key)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.title)
                            Text(f.detail).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .disabled(settings.isOn(f.key) && settings.enabledFeeds.count <= 1)
                }
            } footer: {
                Text("At least one feed stays on.")
            }
            Section {
                Picker("Default feed", selection: $settings.defaultFeed) {
                    ForEach(AppSettings.feeds.filter { settings.isOn($0.key) }, id: \.key) { f in
                        Text(f.title).tag(f.mode)
                    }
                }
            } footer: {
                Text("The feed Home opens on.")
            }
        }
        .navigationTitle("Customize feeds")
        .navigationBarTitleDisplayMode(.inline)
        .followsLook()
    }
}

/// Accounts muted from this app, each with an Unmute button (Instagram's own unmute, posts and
/// stories).
struct MutedAccountsView: View {
    @ObservedObject var settings = AppSettings.shared
    @ObservedObject private var sync = MutedSync.shared
    @State private var asking = false
    @State private var newName = ""
    @State private var adding = false
    @State private var addError: String?
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
                Button {
                    newName = ""
                    asking = true
                } label: {
                    HStack {
                        Label("Add account", systemImage: "plus.circle.fill")
                        if adding { Spacer(); ProgressView() }
                    }
                }
                .disabled(adding)
                if let addError { Text(addError).font(.footnote).foregroundStyle(.red) }
            }
            Section {
            if settings.mutedAccounts.isEmpty {
                Text("No muted accounts. Mute someone from the menu on their post, or the ... menu on their profile.")
                    .foregroundStyle(.secondary)
            }
            ForEach(settings.mutedAccounts, id: \.username) { account in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("@" + account.username)
                        if let what = account.what { Text(what).font(.footnote).foregroundStyle(.secondary) }
                    }
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
        // Always Instagram's real list: muted in the Instagram app or on another phone too.
        .task { await MutedSync.shared.refresh(force: true) }
        .alert("Mute an account", isPresented: $asking) {
            TextField("username", text: $newName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Mute posts") { add(posts: true, story: false) }
            Button("Mute story") { add(posts: false, story: true) }
            Button("Mute posts and story") { add(posts: true, story: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Type their username, then choose what to mute. They aren't told.")
        }
        .toolbar {
            if sync.syncing { ToolbarItem(placement: .topBarTrailing) { ProgressView() } }
        }
        .followsLook()
    }

    private var cleanName: String {
        newName.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "@")).lowercased()
    }

    private func add(posts: Bool, story: Bool) {
        let name = cleanName
        guard !name.isEmpty else { return }
        adding = true
        addError = nil
        Task {
            let ok = await settings.muter?(name, posts, story) ?? false
            adding = false
            if ok { await MutedSync.shared.refresh(force: true) } else { addError = "Couldn't mute @\(name). Check the username and try again." }
        }
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
