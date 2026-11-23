import SwiftUI
import UIKit
import Network
import WebKit
import BackgroundTasks

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
        var liked: Bool?        // already liked when it was loaded
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

    /// A like or unlike from the offline viewer, sent once back online.
    struct LikeChange: Codable, Equatable {
        let pk: String
        var liked: Bool
    }
    /// A reply from the offline viewer: sent as a message to its poster once back online.
    struct Reply: Codable, Equatable {
        let id: String
        let mediaId: String
        let reelId: String
        let ownerId: String
        let text: String
        let at: Int
    }

    enum Phase: Equatable { case idle, loading(done: Int, total: Int), failed(String) }

    @Published private(set) var reels: [Reel] = []
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var offline = false
    /// The viewer: which person to start with (nil when closed).
    @Published var viewerStart: String?
    private(set) var pending: [Seen] = []
    @Published private(set) var likeChanges: [LikeChange] = []
    @Published private(set) var replies: [Reply] = []
    var hasPending: Bool { !pending.isEmpty || !likeChanges.isEmpty || !replies.isEmpty }
    static let refreshTaskId = "com.arjankahlon.following.sync"

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
    private var likesURL: URL { folder.appendingPathComponent("likes.json") }
    private var repliesURL: URL { folder.appendingPathComponent("replies.json") }

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
        if let d = try? Data(contentsOf: likesURL), let p = try? JSONDecoder().decode([LikeChange].self, from: d) { likeChanges = p }
        if let d = try? Data(contentsOf: repliesURL), let p = try? JSONDecoder().decode([Reply].self, from: d) { replies = p }
        dropExpired()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(online) }
        }
        monitor.start(queue: DispatchQueue(label: "following.offline.path"))
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.dropExpired(); self?.sync() }
        }
        // Leaving the app with something still to send: keep going for the time iOS allows, and
        // ask iOS to wake the app later to finish (phase 4).
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.appBackgrounded() }
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
                                music: i["music"] as? String, liked: i["liked"] as? Bool)
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

    /// Watched in the offline viewer: written down for Instagram. The photo stays (and can be
    /// watched again) until Instagram has been told, once back online.
    func watched(_ item: Item, in reel: Reel) {
        guard !pending.contains(where: { $0.mediaId == item.pk }) else { return }
        pending.append(Seen(reelId: reel.id, mediaId: item.pk, ownerId: reel.userId, takenAt: item.takenAt,
                            seenAt: Int(Date().timeIntervalSince1970)))
        savePending()
    }

    func isWatched(_ item: Item) -> Bool { pending.contains { $0.mediaId == item.pk } }

    func isLiked(_ item: Item) -> Bool { likeChanges.first { $0.pk == item.pk }?.liked ?? (item.liked ?? false) }

    /// The heart in the offline viewer: liked (or unliked) now, sent to Instagram once back online.
    func toggleLike(_ item: Item) {
        let now = !isLiked(item)
        likeChanges.removeAll { $0.pk == item.pk }
        if now != (item.liked ?? false) { likeChanges.append(LikeChange(pk: item.pk, liked: now)) }
        saveLikes()
        if now, AppSettings.shared.isOn("hapticLikes") { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        pushState()
    }

    /// A reply typed in the offline viewer: sent to its poster as a message once back online.
    func reply(_ text: String, to item: Item, in reel: Reel) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        replies.append(Reply(id: UUID().uuidString, mediaId: item.id, reelId: reel.id, ownerId: reel.userId, text: t,
                             at: Int(Date().timeIntervalSince1970)))
        saveReplies()
        pushState()
    }

    func replyCount(_ item: Item) -> Int { replies.filter { $0.mediaId == item.id }.count }

    /// The viewer closed: if there's signal, send what was watched.
    func viewerClosed() {
        pushState()
        sync()
    }

    /// Instagram has been told about this story: its photo can go.
    private func synced(_ s: Seen) {
        for i in reels.indices {
            for item in reels[i].items where item.pk == s.mediaId { remove(item.file) }
            reels[i].items.removeAll { $0.pk == s.mediaId }
        }
        dropEmptyReels()
        saveManifest()
    }

    /// Back online, with Instagram's latest story row: photos of stories already seen some other
    /// way (another phone, or Instagram's own viewer) go too.
    func pruneSeen(_ seen: [String: Int]) {
        let waiting = Set(pending.map(\.mediaId))
        var changed = false
        for i in reels.indices {
            guard let s = seen[reels[i].id], s > 0 else { continue }
            for item in reels[i].items where item.takenAt <= s && !waiting.contains(item.pk) { remove(item.file); changed = true }
            reels[i].items.removeAll { $0.takenAt <= s && !waiting.contains($0.pk) }
        }
        if changed { dropEmptyReels(); saveManifest(); pushState() }
    }

    /// Ask the story row's page for Instagram's latest "seen" times and prune with them.
    func checkSeenElsewhere() async {
        guard !offline, !reels.isEmpty, let strip else { return }
        let js = "return JSON.stringify((window.__flTray || []).map(function (r) { return [String(r.id), r.seen || 0]; }))"
        guard let raw = try? await strip.webView.callAsyncJavaScript(js, arguments: [:], contentWorld: .page) as? String,
              let data = raw.data(using: .utf8), let pairs = try? JSONSerialization.jsonObject(with: data) as? [[Any]] else { return }
        var map: [String: Int] = [:]
        for p in pairs where p.count == 2 { if let id = p[0] as? String { map[id] = (p[1] as? Int) ?? Int((p[1] as? Double) ?? 0) } }
        if !map.isEmpty { pruneSeen(map) }
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

    /// Back online: tell Instagram what happened offline, in order: which stories were watched
    /// (Instagram's own "seen" request, PolarisStoriesV3SeenMutation, with the time each was
    /// really watched), then likes (usePolarisStoriesV4LikeMutation), then replies (sent as
    /// messages, IGDirectStoryShareReplyMutation). Anything that fails waits for the next try.
    func sync() { Task { await syncNow() } }

    func syncNow() async {
        guard !offline, !syncing, hasPending, home != nil else { return }
        syncing = true
        defer { syncing = false; pushState() }
        while let s = pending.first, !offline {
            let ok = await send("PolarisStoriesV3SeenMutation", "26234228992942885", [
                "reelId": s.reelId, "reelMediaId": s.mediaId, "reelMediaOwnerId": s.ownerId,
                "reelMediaTakenAt": s.takenAt, "viewSeenAt": s.seenAt])
            if !ok { return }   // try again later (next connection, or next time the app opens)
            pending.removeFirst()
            savePending()
            synced(s)
        }
        while let l = likeChanges.first, !offline {
            let ok = l.liked
                ? await send("usePolarisStoriesV4LikeMutationLikeMutation", "26938887309082050", ["input": ["media_id": l.pk]])
                : await send("usePolarisStoriesV4LikeMutationUnlikeMutation", "26510485515280697", ["input": ["media_id": l.pk]])
            if !ok { return }
            likeChanges.removeFirst()
            saveLikes()
        }
        while let r = replies.first, !offline {
            let otid = String((UInt64(Date().timeIntervalSince1970 * 1000) << 22) | UInt64.random(in: 0..<4_194_304))
            let ok = await send("IGDirectStoryShareReplyMutation", "29327482173525974", [
                "data": ["is_shh_mode": false, "media_id": r.mediaId, "reaction_emoji": NSNull(), "reel_id": r.reelId,
                         "sampled": false, "share_client_context": otid, "text": ["sensitive_string_value": r.text]],
                "send_data": ["forwarded_from_thread_id": NSNull(), "is_forwarded_from_own_message": NSNull(),
                              "offline_threading_id": otid, "recipient_users": "[\"\(r.ownerId)\"]", "thread_id": NSNull()]])
            if !ok { return }
            replies.removeFirst()
            saveReplies()
        }
        if !hasPending { strip?.webView.reload() }   // the row shows them as seen
    }

    /// One of Instagram's own requests, sent from the Home page (which has your session).
    private func send(_ name: String, _ doc: String, _ variables: [String: Any]) async -> Bool {
        #if DEBUG
        if dryRunSync {
            // Simulator testing: nothing is sent, it's only written down.
            let v = (try? JSONSerialization.data(withJSONObject: variables)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
            dryRunLog.append("\(name) \(v)")
            print("[offline sync, not sent] \(name) \(v)")
            return true
        }
        #endif
        guard let home, let data = try? JSONSerialization.data(withJSONObject: variables),
              let json = String(data: data, encoding: .utf8) else { return false }
        let js = "return await window.__flGql(name, doc, JSON.parse(vars)).then(function () { return true; })"
        let r = try? await home.webView.callAsyncJavaScript(js, arguments: ["name": name, "doc": doc, "vars": json], contentWorld: .page)
        return r as? Bool == true
    }

    // MARK: Background (phase 4)

    /// The app went to the background with something still to send: use the time iOS gives a
    /// closing app, and ask iOS to wake it later (it decides when) to finish.
    func appBackgrounded() {
        guard hasPending else { return }
        scheduleRefresh()
        guard !offline else { return }
        var task: UIBackgroundTaskIdentifier = .invalid
        task = UIApplication.shared.beginBackgroundTask(withName: "Send offline stories") {
            UIApplication.shared.endBackgroundTask(task)
        }
        Task {
            await syncNow()
            UIApplication.shared.endBackgroundTask(task)
        }
    }

    func scheduleRefresh() {
        let req = BGAppRefreshTaskRequest(identifier: Self.refreshTaskId)
        req.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }

    /// iOS woke the app in the background: send what's waiting, once the Home page is ready.
    func backgroundRefresh(_ task: BGAppRefreshTask) async {
        var done = false
        task.expirationHandler = { done = true }
        for _ in 0..<40 where !done {
            if !offline, let home, (try? await home.webView.evaluateJavaScript("typeof window.__flGql")) as? String == "function" { break }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        if !done { await syncNow() }
        if hasPending { scheduleRefresh() }
        task.setTaskCompleted(success: !hasPending)
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
    private func saveLikes() { if let d = try? JSONEncoder().encode(likeChanges) { try? d.write(to: likesURL, options: .atomic) } }
    private func saveReplies() { if let d = try? JSONEncoder().encode(replies) { try? d.write(to: repliesURL, options: .atomic) } }
    private func savePending() { if let d = try? JSONEncoder().encode(pending) { try? d.write(to: pendingURL, options: .atomic) } }

    /// The button above the story row (extras.js draws it from this).
    func pushState() {
        let waiting = Set(pending.map(\.mediaId))
        var state: [String: Any] = ["offline": offline, "saved": savedCount, "pending": pending.count + likeChanges.count + replies.count,
                                    "users": reels.filter { !$0.items.isEmpty }.map(\.username),
                                    // Everyone whose saved stories have all been watched: their ring goes gray.
                                    // Anyone with at least one story watched offline counts as seen in the count.
                                    "watchedAny": reels.filter { r in r.items.contains { waiting.contains($0.pk) } }.map(\.username),
                                    "watched": reels.filter { r in !r.items.isEmpty && r.items.allSatisfy { waiting.contains($0.pk) } }.map(\.username)]
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
    @State private var slide: CGFloat = 0
    @State private var replyText = ""
    @State private var note: String?
    @FocusState private var typing: Bool
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
                // The photo sits in the black backdrop, which covers the whole screen and ignores
                // the keyboard: it stays put while typing, and never pushes the reply box off screen.
                Color.black
                    .overlay {
                        if let item, let img = store.image(item.file) {
                            Image(uiImage: img)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    .ignoresSafeArea()
                if item.map({ store.image($0.file) == nil }) ?? true {
                    Text("This story isn't saved").foregroundStyle(.white.opacity(0.7))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                header.padding(.horizontal, 10).padding(.top, 6)
                VStack {
                    Spacer()
                    if let note {
                        Text(note).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(.black.opacity(0.6), in: Capsule())
                            .padding(.bottom, 8)
                            .transition(.opacity)
                    }
                    bottomBar
                }
                // Taps: left third back, the rest forward. Hold to pause.
                HStack(spacing: 0) {
                    Color.clear.contentShape(Rectangle()).frame(width: geo.size.width / 3)
                        .onTapGesture { back() }
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture { next() }
                }
                .padding(.top, 70)
                .padding(.bottom, 90)
                .simultaneousGesture(LongPressGesture(minimumDuration: 0.25).onChanged { _ in paused = true }
                    .onEnded { _ in paused = false })
            }
            .offset(y: max(0, drag))
            .offset(x: slide)
            // Swipe down to close; swipe left or right for the next or previous person.
            .gesture(DragGesture(minimumDistance: 20)
                .onChanged { v in
                    let dx = v.translation.width, dy = v.translation.height
                    if abs(dx) > abs(dy) { slide = dx; drag = 0 } else if dy > 0 { drag = dy; slide = 0 }
                    paused = true
                }
                .onEnded { v in
                    let dx = v.translation.width, dy = v.translation.height
                    if abs(dx) > abs(dy), abs(dx) > 70 {
                        let ok = dx < 0 ? reelIndex + 1 < reels.count : reelIndex > 0
                        if ok {
                            withAnimation(.easeOut(duration: 0.15)) { slide = dx < 0 ? -500 : 500 }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                                dx < 0 ? nextPerson() : previousPerson()
                                slide = dx < 0 ? 500 : -500
                                withAnimation(.easeOut(duration: 0.2)) { slide = 0 }
                                paused = false
                            }
                            return
                        }
                        if dx < 0 { close(); return }   // past the last person
                    }
                    if dy > 120 && abs(dy) > abs(dx) { close(); return }
                    withAnimation(.spring()) { drag = 0; slide = 0 }
                    paused = false
                })
        }
        .statusBarHidden()
        .onAppear {
            // Start at their first story not watched yet (watched ones stay until synced, and
            // can be watched again).
            if let r = reel, let i = r.items.firstIndex(where: { !store.isWatched($0) }) { itemIndex = i }
            markWatched()
        }
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

    /// Reply (a message to its poster) and like, both sent once back online.
    private var bottomBar: some View {
        HStack(spacing: 14) {
            HStack {
                TextField("", text: $replyText, prompt: Text(reel.map { "Reply to \($0.username)…" } ?? "Reply…")
                    .foregroundStyle(.white.opacity(0.75)))
                    .focused($typing)
                    .submitLabel(.send)
                    .onSubmit { sendReply() }
                    .foregroundStyle(.white)
                if typing && !replyText.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button("Send") { sendReply() }.font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                }
            }
            .padding(.horizontal, 16).frame(height: 44)
            .overlay(Capsule().stroke(.white.opacity(0.6), lineWidth: 1))
            if let item {
                Button { store.toggleLike(item) } label: {
                    Image(systemName: store.isLiked(item) ? "heart.fill" : "heart")
                        .font(.system(size: 26))
                        .foregroundStyle(store.isLiked(item) ? Color(red: 1, green: 0.19, blue: 0.25) : .white)
                }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 8)
        .onChange(of: typing) { _, on in paused = on }
    }

    private func sendReply() {
        guard let item, let reel, !replyText.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        store.reply(replyText, to: item, in: reel)
        replyText = ""
        typing = false
        show(store.offline ? "Reply will send when you're back online" : "Reply sending…")
    }

    private func show(_ text: String) {
        withAnimation { note = text }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { withAnimation { if note == text { note = nil } } }
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
        paused = false   // a quick tap starts "hold to pause" without ending it
        markWatched()
    }

    /// The next person's first story not watched yet (or their first).
    private func nextPerson() {
        guard reelIndex + 1 < reels.count else { return close() }
        reelIndex += 1
        itemIndex = reels[reelIndex].items.firstIndex(where: { !store.isWatched($0) }) ?? 0
        progress = 0
        paused = false   // a quick tap starts "hold to pause" without ending it
        markWatched()
    }

    private func previousPerson() {
        guard reelIndex > 0 else { return }
        reelIndex -= 1
        itemIndex = reels[reelIndex].items.firstIndex(where: { !store.isWatched($0) }) ?? 0
        progress = 0
        paused = false   // a quick tap starts "hold to pause" without ending it
        markWatched()
    }

    private func back() {
        if itemIndex > 0 { itemIndex -= 1 }
        else if reelIndex > 0 { reelIndex -= 1; itemIndex = max(0, reels[reelIndex].items.count - 1) }
        progress = 0
        paused = false   // a quick tap starts "hold to pause" without ending it
    }

    private func close() {
        dismiss()
    }
}
