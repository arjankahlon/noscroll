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

    var body: some View {
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
                        .tag(tab)
                        .tabItem { Label(tab.title, systemImage: tab.symbol) }
                }
            }
            .tint(.primary)

            // A story, or a profile or post opened from one or from Friends, fills the screen
            // over everything, the tab bar included (StoriesStrip.swift). The collapsed story row
            // lives inside the Home feed's own scroll view.
            if stories.expanded && selection == .home {
                StoriesLayer(model: stories)
                    .ignoresSafeArea(.container, edges: .bottom)
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

    func controller(for tab: InstaTab) -> InstaWebController {
        if let c = controllers[tab] { return c }
        let c = InstaWebController(tab: tab)
        controllers[tab] = c
        return c
    }

    func goHome(_ tab: InstaTab) {
        controller(for: tab).loadStart()
    }

    /// After you sign in on one tab, the others are still showing the sign-in
    /// page. Reload them when you switch to them.
    func didShow(_ tab: InstaTab) {
        controller(for: tab).reloadIfSignedOut()
    }
}
