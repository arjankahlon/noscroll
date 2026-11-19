import AVFoundation
import SwiftUI

/// Following: Instagram with four tabs and nothing else.
///
/// Home opens the Following feed, Search opens the search box (no Explore grid),
/// Messages opens the inbox, Profile opens your own profile. The NoScroll engine
/// (ios/NoScroll/Resources/noscroll.js) and this app's own rule file
/// (following/Resources/instagram.json) hide Reels, Explore, ads, suggested posts
/// and the posting buttons.
@main
struct FollowingApp: App {
    init() {
        // "Playback" audio: video sound plays with the silent switch on, and a video in Picture
        // in Picture keeps playing when you leave the app (with the "audio" background mode).
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            RootTabs()
        }
    }
}

enum InstaTab: Int, CaseIterable, Identifiable {
    case home, search, messages, profile
    /// Not a tab: the story strip above the Following feed (StoriesStrip.swift).
    case stories
    var id: Int { rawValue }

    /// The four tabs in the bar.
    static let barTabs: [InstaTab] = [.home, .search, .messages, .profile]

    var title: String {
        switch self {
        case .home: return "Home"
        case .search: return "Search"
        case .messages: return "Messages"
        case .profile: return "Profile"
        case .stories: return "Stories"
        }
    }

    var symbol: String {
        switch self {
        case .home: return "house"
        case .search: return "magnifyingglass"
        case .messages: return "paperplane"
        case .profile: return "person.crop.circle"
        case .stories: return "circle.dashed"
        }
    }

    var symbolSelected: String {
        switch self {
        case .home: return "house.fill"
        case .search: return "magnifyingglass"
        case .messages: return "paperplane.fill"
        case .profile: return "person.crop.circle.fill"
        case .stories: return "circle.dashed"
        }
    }

    /// The page each tab opens. Profile needs your username, which the page
    /// tells the app the first time it sees it (see InstaWeb.swift).
    var startURL: URL {
        let base = "https://www.instagram.com"
        switch self {
        case .home: return URL(string: "\(base)/?variant=following")!
        case .search: return URL(string: "\(base)/explore/search/")!
        case .messages: return URL(string: "\(base)/direct/inbox/")!
        case .profile:
            if let user = UserDefaults.standard.string(forKey: InstaWeb.usernameKey), !user.isEmpty {
                return URL(string: "\(base)/\(user)/")!
            }
            return URL(string: "\(base)/?following_profile=1")!
        case .stories: return URL(string: "\(base)/?variant=home&fl_stories=1")!
        }
    }
}

struct RootTabs: View {
    @State private var selection: InstaTab = .home
    @StateObject private var tabs = TabWebViews()
    @StateObject private var stories = StoriesModel()
    @StateObject private var reminder = RefreshReminder()
    @ObservedObject private var profilePic = ProfilePic.shared

    /// Icons only, no labels. Profile shows your own picture once the app has it.
    @ViewBuilder private func tabLabel(_ tab: InstaTab) -> some View {
        if tab == .profile, let pic = profilePic.image {
            Image(uiImage: pic).renderingMode(.original).accessibilityLabel(tab.title)
        } else {
            Image(systemName: tab.symbol).accessibilityLabel(tab.title)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // From 5 days after SideStore last re-signed the app, until it re-signs it again.
            if reminder.show { RefreshBanner(reminder: reminder) }
            content
        }
    }

    private var content: some View {
        ZStack {
            // The system's floating tab bar. Each page runs underneath it to the bottom of the
            // screen; the web views keep their last posts scrollable above it.
            TabView(selection: Binding(
                get: { selection },
                set: { newValue in
                    // Tapping the tab you are already on goes back to its start page.
                    if newValue == selection { tabs.goHome(newValue) }
                    selection = newValue
                    tabs.didShow(newValue)
                }
            )) {
                ForEach(InstaTab.barTabs) { tab in
                    InstaWebView(controller: tabs.controller(for: tab))
                        .ignoresSafeArea(.container, edges: .bottom)
                        .toolbar(tabs.barHidden.contains(tab) ? .hidden : .visible, for: .tabBar)
                        .tag(tab)
                        .tabItem { tabLabel(tab) }
                }
            }
            .tint(.primary)

            // A story, or a profile or post opened from one or from Friends, fills the screen
            // over everything, the tab bar included (StoriesStrip.swift). The collapsed story row
            // lives inside the Home feed's own scroll view.
            if stories.expanded && selection == .home {
                StoriesLayer(model: stories)
                    .ignoresSafeArea(.container, edges: .bottom)
                    .overlay {
                        if stories.opening { ProgressView().controlSize(.large) }
                    }
                    .overlay(alignment: .topLeading) {
                        if !stories.onStoryPage {
                            Button { stories.back() } label: {
                                Image(systemName: "chevron.backward")
                                    .font(.system(size: 18, weight: .semibold))
                                    .foregroundStyle(Color.primary)
                                    .frame(width: 44, height: 44)
                                    .background(.regularMaterial, in: Circle())
                            }
                            .accessibilityLabel("Back")
                            .padding(.leading, 10)
                            .padding(.top, 6)
                        }
                    }
                    .transition(.opacity)
            }
        }
        .onAppear {
            stories.attach(home: tabs.controller(for: .home), strip: tabs.controller(for: .stories))
        }
    }
}

/// One web view per tab, made once and kept, so each tab keeps its place.
@MainActor
final class TabWebViews: ObservableObject {
    private var controllers: [InstaTab: InstaWebController] = [:]
    private var observers: [NSKeyValueObservation] = []

    /// Tabs showing a page that needs the bottom of the screen: a DM chat, whose message box
    /// and keyboard would sit behind the tab bar. The tab bar hides there, as in Instagram's app.
    @Published private(set) var barHidden: Set<InstaTab> = []

    func controller(for tab: InstaTab) -> InstaWebController {
        if let c = controllers[tab] { return c }
        let c = InstaWebController(tab: tab)
        controllers[tab] = c
        observers.append(c.webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
            let hide = Self.needsFullHeight(wv.url)
            Task { @MainActor in
                guard let self else { return }
                if hide { self.barHidden.insert(tab) } else { self.barHidden.remove(tab) }
            }
        })
        return c
    }

    /// A DM chat (/direct/t/...), or a new message.
    nonisolated static func needsFullHeight(_ url: URL?) -> Bool {
        guard let path = url?.path else { return false }
        return path.hasPrefix("/direct/t/") || path.hasPrefix("/direct/new")
    }

    func goHome(_ tab: InstaTab) {
        let c = controller(for: tab)
        #if DEBUG
        DebugHooks.log("goHome \(tab) url=\(c.webView.url?.absoluteString ?? "nil") onFeed=\(StoriesModel.isFollowingFeed(c.webView.url))")
        #endif
        // Home, already on the feed: refresh in place (quick). Otherwise back to the start page.
        if tab == .home, StoriesModel.isFollowingFeed(c.webView.url) {
            c.refreshOrReload()
        } else {
            c.loadStart()
        }
    }

    /// After you sign in on one tab, the others are still showing the sign-in
    /// page. Reload them when you switch to them.
    func didShow(_ tab: InstaTab) {
        controller(for: tab).reloadIfSignedOut()
    }
}
