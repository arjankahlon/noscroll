import SwiftUI
import UIKit
import Network
import WebKit

/// "Load all stories": for a stretch without signal (the subway).
///
/// Tapping the button above the story row downloads every photo story you haven't watched yet
/// (videos are left alone: not downloaded, not watched, still unseen in the row). Loading them
/// doesn't tell Instagram anything: only watching does. While offline, tapping someone in the
/// story row opens these copies in the app's own viewer, and each one you watch is written down
/// (on the phone, so it survives the app being closed). Back online, the app tells Instagram,
/// with Instagram's own "seen" request and the time you actually watched it, then forgets it.
/// Each photo is deleted once watched, and any left over are deleted when the story expires
/// (or when you open that person's stories in Instagram's own viewer, online).
@MainActor
final class OfflineStories: ObservableObject {
    static let shared = OfflineStories()

    struct Item: Codable, Identifiable, Equatable {
        let id: String          // Instagram's media id ("pk_ownerId")
        let pk: String
        let takenAt: Int
        let expiresAt: Int
        let file: String        // file name in the folder
        let width: Int
        let height: Int
        let music: String?      // "Song · Artist", shown without audio
    }
    struct Reel: Codable, Identifiable, Equatable {
        let id: String          // reel id (the owner's id)
        let userId: String
        let username: String
        var picFile: String?
        var items: [Item]
    }
    /// A story watched offline, for Instagram's "seen" request once back online.
    struct Seen: Codable, Equatable {
        let reelId: String
        let mediaId: String
        let ownerId: String
        let takenAt: Int
        let seenAt: Int
    }

    enum Phase: Equatable { case idle, loading(done: Int, total: Int), failed(String) }

    @Published private(set) var reels: [Reel] = []
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var offline = false
    /// The viewer: which person to start with (nil when closed).
    @Published var viewerStart: String?
    private(set) var pending: [Seen] = []

    weak var strip: InstaWebController?
    weak var home: InstaWebController?

    private let monitor = NWPathMonitor()
    private var syncing = false
    private let folder: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("OfflineStories", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    private var manifestURL: URL { folder.appendingPathComponent("stories.json") }
    private var pendingURL: URL { folder.appendingPathComponent("seen.json") }

    var savedCount: Int { reels.reduce(0) { $0 + $1.items.count } }

    #if DEBUG
    /// Simulator testing only: act as if there were no connection.
    var forceOffline = UserDefaults.standard.bool(forKey: "debug.forceOffline") {
        didSet { UserDefaults.standard.set(forceOffline, forKey: "debug.forceOffline"); pathChanged(realOnline) }
    }
    /// Simulator testing only: write down what would be sent instead of sending it.
    var dryRunSync = UserDefaults.standard.object(forKey: "debug.dryRunSync") as? Bool ?? true
    private(set) var dryRunLog: [String] = []
    #endif
    private var realOnline = true

    private init() {
        if let d = try? Data(contentsOf: manifestURL), let r = try? JSONDecoder().decode([Reel].self, from: d) { reels = r }
        if let d = try? Data(contentsOf: pendingURL), let p = try? JSONDecoder().decode([Seen].self, from: d) { pending = p }
        dropExpired()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(online) }
        }
        monitor.start(queue: DispatchQueue(label: "following.offline.path"))
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.dropExpired(); self?.sync() }
        }
    }

    private func pathChanged(_ online: Bool) {
        realOnline = online
        var off = !online
        #if DEBUG
        if forceOffline { off = true }
        #endif
        if off != offline { offline = off }
        pushState()
        if !off { sync() }
    }

    // MARK: Loading

    /// The button above the story row. Offline: open the saved stories. Online: load (again,
    /// for anything new since last time).
    func buttonTapped() {
        if case .loading = phase { return }
        if offline {
            if savedCount > 0 { viewerStart = reels.first?.username }
            return
        }
        Task { await load() }
    }

    func load() async {
        guard let strip else { return }
        phase = .loading(done: 0, total: 0)
        pushState()
        let js = "return await window.__flOfflineList()"
        let raw: Any?
        do { raw = try await strip.webView.callAsyncJavaScript(js, arguments: [:], contentWorld: .page) }
        catch { fail("Couldn't load stories"); return }
        guard let s = raw as? String, let data = s.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { fail("Couldn't load stories"); return }

        // What's new: skip anything already saved.
        let have = Set(reels.flatMap { $0.items.map(\.id) })
        var jobs: [(reel: Reel, items: [(Item, URL)], pic: URL?)] = []
        for r in list {
            guard let id = r["reelId"] as? String, let uid = r["userId"] as? String, let name = r["username"] as? String,
                  let its = r["items"] as? [[String: Any]] else { continue }
            var items: [(Item, URL)] = []
            for i in its {
                guard let mid = i["id"] as? String, !have.contains(mid), let u = i["url"] as? String, let url = URL(string: u) else { continue }
                let pk = i["pk"] as? String ?? mid
                let item = Item(id: mid, pk: pk, takenAt: i["takenAt"] as? Int ?? 0, expiresAt: i["expiresAt"] as? Int ?? 0,
                                file: "\(pk).jpg", width: i["w"] as? Int ?? 1080, height: i["h"] as? Int ?? 1920,
                                music: i["music"] as? String)
                items.append((item, url))
            }
            if items.isEmpty { continue }
            jobs.append((Reel(id: id, userId: uid, username: name, picFile: nil, items: []), items,
                         (r["pic"] as? String).flatMap(URL.init(string:))))
        }
        let total = jobs.reduce(0) { $0 + $1.items.count }
        var done = 0
        phase = .loading(done: 0, total: total)
        pushState()
        for job in jobs {
            var reel = reels.first(where: { $0.id == job.reel.id }) ?? job.reel
            if reel.picFile == nil, let pic = job.pic, await download(pic, to: "pic_\(reel.userId).jpg") {
                reel.picFile = "pic_\(reel.userId).jpg"
            }
            for (item, url) in job.items {
                if await download(url, to: item.file) { reel.items.append(item) }
                done += 1
                phase = .loading(done: done, total: total)
                pushState()
            }
            reel.items.sort { $0.takenAt < $1.takenAt }
            if let i = reels.firstIndex(where: { $0.id == reel.id }) { reels[i] = reel }
            else if !reel.items.isEmpty { reels.append(reel) }
            saveManifest()
        }
        phase = .idle
        pushState()
    }

    private func fail(_ message: String) {
        phase = .failed(message)
        pushState()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            guard let self, case .failed = self.phase else { return }
            self.phase = .idle
            self.pushState()
        }
    }

    private func download(_ url: URL, to name: String) async -> Bool {
        do {
            let (data, resp) = try await URLSession.shared.data(from: url)
            guard (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return false }
            try data.write(to: folder.appendingPathComponent(name), options: .atomic)
            return true
        } catch { return false }
    }

    func image(_ file: String?) -> UIImage? {
        guard let file else { return nil }
        return UIImage(contentsOfFile: folder.appendingPathComponent(file).path)
    }

    // MARK: Watching

    /// Watched in the offline viewer: written down for Instagram. (The photo is deleted when the
    /// viewer closes, so going back a story still works.)
    func watched(_ item: Item, in reel: Reel) {
        guard !pending.contains(where: { $0.mediaId == item.pk }) else { return }
        pending.append(Seen(reelId: reel.id, mediaId: item.pk, ownerId: reel.userId, takenAt: item.takenAt,
                            seenAt: Int(Date().timeIntervalSince1970)))
        savePending()
    }

    /// The viewer closed: delete what was watched.
    func viewerClosed() {
        let seen = Set(pending.map(\.mediaId))
        for i in reels.indices {
            for item in reels[i].items where seen.contains(item.pk) { remove(item.file) }
            reels[i].items.removeAll { seen.contains($0.pk) }
        }
        dropEmptyReels()
        saveManifest()
        pushState()
        sync()
    }

    /// Opened someone's stories in Instagram's own viewer (online): their copies are no longer needed.
    func openedOnline(username: String) {
        guard let i = reels.firstIndex(where: { $0.username.lowercased() == username.lowercased() }) else { return }
        for item in reels[i].items { remove(item.file) }
        if let pic = reels[i].picFile { remove(pic) }
        reels.remove(at: i)
        saveManifest()
        pushState()
    }

    func reel(startingAt username: String?) -> [Reel] {
        guard let username, let i = reels.firstIndex(where: { $0.username == username }) else { return reels }
        return Array(reels[i...])
    }

    func has(username: String) -> Bool { reels.contains { $0.username == username && !$0.items.isEmpty } }

    // MARK: Syncing

    /// Tell Instagram about stories watched offline, oldest first, the way its own viewer does
    /// (PolarisStoriesV3SeenMutation), with the time each one was really watched.
    func sync() {
        guard !offline, !syncing, !pending.isEmpty, let home else { return }
        syncing = true
        Task {
            defer { syncing = false }
            while let s = pending.first, !offline {
                #if DEBUG
                if dryRunSync {
                    dryRunLog.append("seen reel=\(s.reelId) media=\(s.mediaId) owner=\(s.ownerId) taken=\(s.takenAt) seenAt=\(s.seenAt)")
                    pending.removeFirst()
                    savePending()
                    continue
                }
                #endif
                let js = """
                return await window.__flGql('PolarisStoriesV3SeenMutation', '26234228992942885', \
                {reelId: reelId, reelMediaId: mediaId, reelMediaOwnerId: ownerId, reelMediaTakenAt: takenAt, viewSeenAt: seenAt}).then(function () { return true; })
                """
                let ok = (try? await home.webView.callAsyncJavaScript(js, arguments: [
                    "reelId": s.reelId, "mediaId": s.mediaId, "ownerId": s.ownerId, "takenAt": s.takenAt, "seenAt": s.seenAt,
                ], contentWorld: .page)) as? Bool == true
                if !ok { break }   // try again later (next connection, or next time the app opens)
                pending.removeFirst()
                savePending()
            }
            pushState()
            if pending.isEmpty { strip?.webView.reload() }   // the row shows them as seen
        }
    }

    // MARK: Housekeeping

    private func dropExpired() {
        let now = Int(Date().timeIntervalSince1970)
        var changed = false
        for i in reels.indices {
            for item in reels[i].items where item.expiresAt > 0 && item.expiresAt < now { remove(item.file); changed = true }
            reels[i].items.removeAll { $0.expiresAt > 0 && $0.expiresAt < now }
        }
        if changed { dropEmptyReels(); saveManifest() }
    }

    private func dropEmptyReels() {
        for r in reels where r.items.isEmpty { if let pic = r.picFile { remove(pic) } }
        reels.removeAll { $0.items.isEmpty }
    }

    private func remove(_ file: String) { try? FileManager.default.removeItem(at: folder.appendingPathComponent(file)) }
    private func saveManifest() { if let d = try? JSONEncoder().encode(reels) { try? d.write(to: manifestURL, options: .atomic) } }
    private func savePending() { if let d = try? JSONEncoder().encode(pending) { try? d.write(to: pendingURL, options: .atomic) } }

    /// The button above the story row (extras.js draws it from this).
    func pushState() {
        var state: [String: Any] = ["offline": offline, "saved": savedCount, "pending": pending.count,
                                    "users": reels.filter { !$0.items.isEmpty }.map(\.username)]
        switch phase {
        case .idle: state["phase"] = "idle"
        case .loading(let d, let t): state["phase"] = "loading"; state["done"] = d; state["total"] = t
        case .failed(let m): state["phase"] = "failed"; state["message"] = m
        }
        guard let data = try? JSONSerialization.data(withJSONObject: state), let json = String(data: data, encoding: .utf8) else { return }
        strip?.webView.evaluateJavaScript("window.__flOfflineState && window.__flOfflineState(\(json))", completionHandler: nil)
    }
}

// MARK: - Viewer

/// The app's own story viewer, for the saved photos: tap the right side for the next story, the
/// left for the one before, hold to pause, swipe down to close. Moves on to the next person.
struct OfflineStoryViewer: View {
    @ObservedObject var store = OfflineStories.shared
    @Environment(\.dismiss) private var dismiss
    let reels: [OfflineStories.Reel]
    @State private var reelIndex = 0
    @State private var itemIndex = 0
    @State private var progress: Double = 0
    @State private var paused = false
    @State private var drag: CGFloat = 0
    private let duration: Double = 5
    private let tick = Timer.publish(every: 0.05, on: .main, in: .common).autoconnect()

    private var reel: OfflineStories.Reel? { reels.indices.contains(reelIndex) ? reels[reelIndex] : nil }
    private var item: OfflineStories.Item? {
        guard let reel, reel.items.indices.contains(itemIndex) else { return nil }
        return reel.items[itemIndex]
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                Color.black.ignoresSafeArea()
                if let item, let img = store.image(item.file) {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    Text("This story isn't saved").foregroundStyle(.white.opacity(0.7))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                header.padding(.horizontal, 10).padding(.top, 6)
                // Taps: left third back, the rest forward. Hold to pause.
                HStack(spacing: 0) {
                    Color.clear.contentShape(Rectangle()).frame(width: geo.size.width / 3)
                        .onTapGesture { back() }
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture { next() }
                }
                .padding(.top, 70)
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.25).onChanged { _ in paused = true }
                    .onEnded { _ in paused = false })
            }
            .offset(y: max(0, drag))
            .gesture(DragGesture(minimumDistance: 20)
                .onChanged { v in if v.translation.height > 0 { drag = v.translation.height; paused = true } }
                .onEnded { v in
                    if v.translation.height > 120 { close() } else { withAnimation(.spring()) { drag = 0 }; paused = false }
                })
        }
        .statusBarHidden()
        .onAppear { markWatched() }
        .onReceive(tick) { _ in
            guard !paused, item != nil else { return }
            progress += 0.05 / duration
            if progress >= 1 { next() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let reel {
                HStack(spacing: 3) {
                    ForEach(reel.items.indices, id: \.self) { i in
                        GeometryReader { g in
                            ZStack(alignment: .leading) {
                                Capsule().fill(.white.opacity(0.35))
                                Capsule().fill(.white)
                                    .frame(width: g.size.width * (i < itemIndex ? 1 : i == itemIndex ? progress : 0))
                            }
                        }
                        .frame(height: 2.5)
                    }
                }
                HStack(spacing: 8) {
                    if let pic = store.image(reel.picFile) {
                        Image(uiImage: pic).resizable().frame(width: 32, height: 32).clipShape(Circle())
                    } else {
                        Circle().fill(.white.opacity(0.3)).frame(width: 32, height: 32)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Text(reel.username).font(.system(size: 14, weight: .semibold))
                            if let item { Text(ago(item.takenAt)).font(.system(size: 14)).opacity(0.75) }
                        }
                        if let music = item?.music {
                            Label(music, systemImage: "music.note").font(.system(size: 12)).lineLimit(1).opacity(0.9)
                        }
                    }
                    Spacer()
                    Label("Offline", systemImage: "icloud.slash").labelStyle(.iconOnly).font(.system(size: 15)).opacity(0.8)
                    Button { close() } label: {
                        Image(systemName: "xmark").font(.system(size: 20, weight: .semibold)).padding(6)
                    }
                }
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.4), radius: 3)
            }
        }
    }

    private func ago(_ t: Int) -> String {
        let s = max(0, Int(Date().timeIntervalSince1970) - t)
        return s < 3600 ? "\(max(1, s / 60))m" : "\(s / 3600)h"
    }

    private func markWatched() {
        guard let reel, let item else { return }
        store.watched(item, in: reel)
    }

    private func next() {
        guard let reel else { return close() }
        if itemIndex + 1 < reel.items.count { itemIndex += 1 }
        else if reelIndex + 1 < reels.count { reelIndex += 1; itemIndex = 0 }
        else { return close() }
        progress = 0
        markWatched()
    }

    private func back() {
        if itemIndex > 0 { itemIndex -= 1 }
        else if reelIndex > 0 { reelIndex -= 1; itemIndex = max(0, reels[reelIndex].items.count - 1) }
        progress = 0
    }

    private func close() {
        dismiss()
    }
}
