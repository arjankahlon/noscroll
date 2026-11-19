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
    @ObservedObject private var dmBadge = DMBadge.shared
    @ObservedObject private var guide = Guide.shared
    @ObservedObject private var settings = AppSettings.shared
    @ObservedObject private var settingsPane = SettingsPane.shared
    @ObservedObject private var profilePic = ProfilePic.shared

    /// Icons only, no labels. Profile shows your own picture once the app has it.
    @ViewBuilder private func tabLabel(_ tab: InstaTab) -> some View {
        if tab == .profile, let pic = profilePic.image {
            Image(uiImage: pic).renderingMode(.original).accessibilityLabel(tab.title)
        } else if tab == .messages {
            Image(uiImage: PlaneIcon.image).renderingMode(.template).accessibilityLabel(tab.title)
        } else {
            Image(systemName: tab.symbol).accessibilityLabel(tab.title)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // From 5 days after SideStore last re-signed the app, until it re-signs it again.
            if reminder.show {
                RefreshBanner(reminder: reminder)
                // The banner sits a little higher than its full height: the gap below keeps the
                // stories line where it would be, with more room above it.
                Color(.systemBackground).frame(height: 8)
            }
            content
        }
        // How to refresh in SideStore: from the (i) above the stories or on the orange banner.
        .fullScreenCover(isPresented: $guide.show) { RefreshGuideView(reminder: reminder) }
        // The app's settings: from the Following icon on your profile. Pages reload when it
        // closes if anything changed.
        .fullScreenCover(isPresented: $settingsPane.show, onDismiss: {
            guard settings.changed else { return }
            settings.markSeen()
            tabs.applySettings()
            reminder.update()
        }) { SettingsView() }
        // Grayscale and Appearance: everything, tab bar and banners included, at once.
        .followsLook()
    }

    private var content: some View {
        ZStack {
            // The system's floating tab bar. Each page runs underneath it to the bottom of the
            // screen; the web views keep their last posts scrollable above it.
            TabView(selection: Binding(
                get: { selection },
                set: { newValue in
                    // A light tap you can feel on every tab bar button.
                    if settings.isOn("hapticTabs") { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
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
                        .badge(tab == .messages ? dmBadge.count : 0)
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
        .onChange(of: reminder.show) { _, shown in stories.bannerShown = shown }
        // Feedback (on the refresh page): a chat with the author, in the Messages tab.
        .onChange(of: guide.feedbackRequest) { _, _ in
            selection = .messages
            tabs.controller(for: .messages).open(Guide.feedbackURL)
        }
        .onAppear {
            settings.unmuter = { [weak tabs] id in await tabs?.unmute(id) ?? false }
            stories.bannerShown = reminder.show
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
    /// Unmute an account (posts and stories) through Instagram, from the Home page.
    func unmute(_ id: String) async -> Bool {
        let js = """
        return await window.__flIgAction('/api/v1/friendships/unmute_posts_or_story_from_follow/',
          { target_posts_author_id: id, target_reel_author_id: id }).then(function () { return true; }, function () { return false; });
        """
        let result = try? await controller(for: .home).webView.callAsyncJavaScript(js, arguments: ["id": id], contentWorld: .page)
        return (result as? Bool) == true || (result as? NSNumber)?.boolValue == true
    }

    /// Settings changed: every page gets the new settings (and reloads).
    func applySettings() {
        for c in controllers.values { c.applySettings() }
    }

    func didShow(_ tab: InstaTab) {
        controller(for: tab).reloadIfSignedOut()
        // Back on Home: a "You're all caught up" check on screen draws itself in again.
        if tab == .home {
            controller(for: tab).webView.evaluateJavaScript("window.__flReplayCheck && window.__flReplayCheck()", completionHandler: nil)
        }
    }
}

/// The Messages tab's icon: the same paper plane as the Share button on posts (an outlined plane
/// pointing up and to the right), drawn at the tab bar's usual icon size.
enum PlaneIcon {
    static let image: UIImage = {
        let size = CGSize(width: 26, height: 26)
        let img = UIGraphicsImageRenderer(size: size).image { _ in
            // The 24 x 24 drawing from extras.js (PLANE), scaled to fit with room for the line.
            let s = (size.width - 2) / 24, o: CGFloat = 1
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o + x * s, y: o + y * s) }
            let path = UIBezierPath()
            path.move(to: p(21.5, 2.5)); path.addLine(to: p(2.5, 9.8)); path.addLine(to: p(9.8, 13))
            path.addLine(to: p(13, 20.5)); path.close()
            path.move(to: p(9.8, 13)); path.addLine(to: p(21.5, 2.5))
            path.lineWidth = 2
            path.lineJoinStyle = .round
            path.lineCapStyle = .round
            UIColor.black.setStroke()
            path.stroke()
        }
        return img.withRenderingMode(.alwaysTemplate)
    }()
}
