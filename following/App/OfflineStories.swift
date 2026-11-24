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
    private var hiddenURL: URL { folder.appendingPathComponent("unreported.json") }

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
        if let d = try? Data(contentsOf: todoURL), let p = try? JSONDecoder().decode([Todo].self, from: d) { todo = p }
        if let d = try? Data(contentsOf: hiddenURL), let p = try? JSONDecoder().decode(Set<String>.self, from: d) { unreported = p }
        dropExpired()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(online) }
        }
        monitor.start(queue: DispatchQueue(label: "following.offline.path"))
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.dropExpired(); self?.sync(); await self?.runTodo() }
        }
        // Leaving the app with something still to send: keep going for the time iOS allows, and
        // ask iOS to wake the app later to finish (phase 4).
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.appBackgrounded() }
        }
        // Force-closed (swiped away in the app switcher): delete the saved photos. iOS only says
        // so while the app is still running; once it's asleep in the background it's closed
        // without a word (just as when iOS frees memory), and the photos stay.
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.clearForQuit() }
        }
    }

    /// clearAll, done at once as the app closes: photos go, except ones watched offline that
    /// Instagram hasn't heard about yet (they're still sent next time).
    private func clearForQuit() {
        todo.removeAll()
        saveTodo()
        let waiting = Set(pending.map(\.mediaId))
        for i in reels.indices {
            for item in reels[i].items where !waiting.contains(item.pk) { remove(item.file) }
            reels[i].items.removeAll { !waiting.contains($0.pk) }
        }
        dropEmptyReels()
        saveManifest()
    }

    private func pathChanged(_ online: Bool) {
        realOnline = online
        if !online { noSignal = false }   // iOS knows it's offline: no need to guess
        refresh()
    }

    private func refresh() {
        var off = !realOnline || noSignal
        #if DEBUG
        if forceOffline { off = true }
        #endif
        if off != offline { offline = off }
        pushState()
        if !off { sync(); Task { await runTodo() } }
    }

    // MARK: "1 bar, no signal"

    /// iOS says there's a connection, but nothing gets through (a bar or two in the subway).
    /// Treated as offline until a check gets an answer again.
    private var noSignal = false
    private var probeTimer: Timer?

    /// Can anything reach Instagram right now? Any answer at all counts; nothing within a couple
    /// of seconds doesn't.
    func probe() async -> Bool {
        var req = URLRequest(url: URL(string: "https://www.instagram.com/favicon.ico")!)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 2.5
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do { _ = try await URLSession.shared.data(for: req); return true } catch { return false }
    }

    private func lostSignal() {
        guard !noSignal else { return }
        noSignal = true
        refresh()
        probeTimer?.invalidate()
        probeTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.noSignal, await self.probe() else { return }
                self.noSignal = false
                self.probeTimer?.invalidate()
                self.probeTimer = nil
                self.refresh()
            }
        }
    }

    /// Someone's stories are opening in Instagram's own viewer. If they're saved here, check the
    /// connection: if nothing gets through, go back to the row and open the saved copy instead
    /// (and switch to offline mode). If it works, the saved copies aren't needed any more.
    func instagramViewerOpening(username: String) {
        guard !offline else { return }
        guard has(username: username) else { openedOnline(username: username); return }
        Task {
            if await probe() {
                openedOnline(username: username)
            } else {
                lostSignal()
                strip?.webView.evaluateJavaScript("history.back()", completionHandler: nil)
                viewerStart = username
            }
        }
    }

    // MARK: Loading

    /// The button above the story row. Offline: open the saved stories. Online: load (again,
    /// for anything new since last time).
    /// The button above the story row. Offline: open the saved stories. Online with stories
    /// saved ("62 available offline"): clear them. Otherwise: load them.
    func buttonTapped() {
        if offline {
            if savedCount > 0 { viewerStart = reels.first?.username }
            return
        }
        if case .loading = phase { return }
        if savedCount > 0 { clearAll(); return }
        Task { await load() }
    }

    /// "Allow offline stories" switched off in App settings: nothing saved is kept (anything still
    /// waiting to be sent to Instagram still goes).
    func settingsChanged() {
        if !AppSettings.shared.isOn("offlineStories") && (savedCount > 0 || !todo.isEmpty) { clearAll() }
    }

    /// Delete every saved story, except ones watched offline that Instagram hasn't heard about
    /// yet (they go once they're sent).
    func clearAll() {
        todo.removeAll()
        saveTodo()
        let waiting = Set(pending.map(\.mediaId))
        for i in reels.indices {
            for item in reels[i].items where !waiting.contains(item.pk) { remove(item.file) }
            reels[i].items.removeAll { !waiting.contains($0.pk) }
        }
        dropEmptyReels()
        saveManifest()
        pushState()
        sync()
    }

    /// One photo still to download (kept on the phone, so a download cut off by losing signal
    /// carries on by itself once the connection is back).
    struct Todo: Codable, Equatable {
        let reelId: String
        let userId: String
        let username: String
        let pic: String?
        let item: Item
        let url: String
    }
    @Published private(set) var todo: [Todo] = []
    private var downloading = false
    private var todoURL: URL { folder.appendingPathComponent("todo.json") }

    func load() async {
        guard let strip, !downloading else { return }
        phase = .loading(done: 0, total: 0)
        pushState()
        let js = "return await window.__flOfflineList()"
        let raw: Any?
        do { raw = try await strip.webView.callAsyncJavaScript(js, arguments: [:], contentWorld: .page) }
        catch { fail("Couldn't load stories"); return }
        guard let s = raw as? String, let data = s.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { fail("Couldn't load stories"); return }

        // What's new: skip anything already saved or already waiting.
        let have = Set(reels.flatMap { $0.items.map(\.id) } + todo.map(\.item.id))
        for r in list {
            guard let id = r["reelId"] as? String, let uid = r["userId"] as? String, let name = r["username"] as? String,
                  let its = r["items"] as? [[String: Any]] else { continue }
            for i in its {
                guard let mid = i["id"] as? String, !have.contains(mid), let u = i["url"] as? String else { continue }
                let pk = i["pk"] as? String ?? mid
                let item = Item(id: mid, pk: pk, takenAt: i["takenAt"] as? Int ?? 0, expiresAt: i["expiresAt"] as? Int ?? 0,
                                file: "\(pk).jpg", width: i["w"] as? Int ?? 1080, height: i["h"] as? Int ?? 1920,
                                music: i["music"] as? String, liked: i["liked"] as? Bool)
                todo.append(Todo(reelId: id, userId: uid, username: name, pic: r["pic"] as? String, item: item, url: u))
            }
        }
        saveTodo()
        await runTodo()
    }

    /// Download what's waiting, one photo at a time; each is watchable offline as soon as it's in.
    /// Losing signal stops it (what's left waits); it picks up again when the connection is back.
    func runTodo() async {
        guard !downloading, !todo.isEmpty else {
            if case .loading = phase, !downloading { phase = .idle; pushState() }
            return
        }
        downloading = true
        defer { downloading = false }
        let total = todo.count
        var done = 0
        phase = .loading(done: 0, total: total)
        pushState()
        while let t = todo.first, !offline {
            let now = Int(Date().timeIntervalSince1970)
            var ok = false
            if t.item.expiresAt == 0 || t.item.expiresAt > now, let url = URL(string: t.url) {
                ok = await download(url, to: t.item.file)
            }
            if !ok && !offline, !(await probe()) { lostSignal() }
            if !ok && offline { break }   // signal lost mid-download: try this one again later
            if ok {
                var reel = reels.first(where: { $0.id == t.reelId })
                    ?? Reel(id: t.reelId, userId: t.userId, username: t.username, picFile: nil, items: [])
                if reel.picFile == nil, let p = t.pic, let pic = URL(string: p), await download(pic, to: "pic_\(t.userId).jpg") {
                    reel.picFile = "pic_\(t.userId).jpg"
                }
                if !reel.items.contains(where: { $0.id == t.item.id }) { reel.items.append(t.item) }
                reel.items.sort { $0.takenAt < $1.takenAt }
                if let i = reels.firstIndex(where: { $0.id == reel.id }) { reels[i] = reel } else { reels.append(reel) }
                saveManifest()
            }
            todo.removeFirst()
            saveTodo()
            done += 1
            phase = .loading(done: done, total: total)
            pushState()
        }
        phase = .idle
        pushState()
    }

    private func saveTodo() { if let d = try? JSONEncoder().encode(todo) { try? d.write(to: todoURL, options: .atomic) } }

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
            var req = URLRequest(url: url)
            req.timeoutInterval = 15   // don't hang for a minute when the signal goes
            let (data, resp) = try await URLSession.shared.data(for: req)
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
        guard !unreported.contains(item.pk), !pending.contains(where: { $0.mediaId == item.pk }) else { return }
        pending.append(Seen(reelId: reel.id, mediaId: item.pk, ownerId: reel.userId, takenAt: item.takenAt,
                            seenAt: Int(Date().timeIntervalSince1970)))
        savePending()
    }

    func isWatched(_ item: Item) -> Bool { unreported.contains(item.pk) || pending.contains { $0.mediaId == item.pk } }

    /// Stories watched offline that Instagram won't be told about (the eye in the viewer).
    @Published private(set) var unreported: Set<String> = []
    func isUnreported(_ item: Item) -> Bool { unreported.contains(item.pk) }

    /// The crossed-out eye: don't tell Instagram this story was watched (or, tapped again, do).
    func toggleUnreported(_ item: Item, in reel: Reel) {
        if unreported.remove(item.pk) == nil {
            unreported.insert(item.pk)
            pending.removeAll { $0.mediaId == item.pk }
        } else {
            watched(item, in: reel)
        }
        savePending()
        saveUnreported()
    }

    /// Back online: stories watched without telling Instagram aren't sent, and their photos go
    /// (like the ones that were sent).
    private func dropUnreported() {
        guard !unreported.isEmpty else { return }
        for i in reels.indices {
            for item in reels[i].items where unreported.contains(item.pk) { remove(item.file) }
            reels[i].items.removeAll { unreported.contains($0.pk) }
        }
        unreported.removeAll()
        saveUnreported()
        dropEmptyReels()
        saveManifest()
    }
    private func saveUnreported() { if let d = try? JSONEncoder().encode(unreported) { try? d.write(to: hiddenURL, options: .atomic) } }

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
        if !offline { dropUnreported() }
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

    /// Apple's own symbols for the button (the App Store's cloud download, a circled arrow once
    /// saved, no Wi-Fi when offline), as pictures the page tints to match the text.
    static let icons: [String: String] = {
        var out: [String: String] = [:]
        let names = ["down": "icloud.and.arrow.down", "saved": "arrow.down.circle", "off": "wifi.slash"]
        let cfg = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
        for (key, name) in names {
            guard let img = UIImage(systemName: name, withConfiguration: cfg)?
                .withTintColor(.black, renderingMode: .alwaysOriginal) else { continue }
            let r = UIGraphicsImageRenderer(size: img.size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 3; return f }())
            let png = r.pngData { _ in img.draw(at: .zero) }
            out[key] = "data:image/png;base64," + png.base64EncodedString() + "|\(Int(img.size.width.rounded()))x\(Int(img.size.height.rounded()))"
        }
        return out
    }()

    /// The button above the story row (extras.js draws it from this).
    func pushState() {
        let waiting = Set(pending.map(\.mediaId)).union(unreported)
        var state: [String: Any] = ["offline": offline, "saved": savedCount, "toDownload": todo.count, "pending": pending.count + likeChanges.count + replies.count,
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
        state["icons"] = Self.icons
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
    @State private var pressStart: Date?
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
                VStack {
                    Spacer()
                    bottomBar
                }
                // One touch area for everything, like Instagram's: touching pauses (for as long as
                // you hold); a quick tap goes back (left third) or forward; a sideways swipe works
                // like a tap on that side; swiping down closes.
                Color.clear.contentShape(Rectangle())
                    .padding(.top, 110)
                    .padding(.bottom, 90)
                    .gesture(DragGesture(minimumDistance: 0)
                        .onChanged { v in
                            if pressStart == nil { pressStart = Date() }
                            paused = true
                            let dy = v.translation.height
                            if dy > abs(v.translation.width), dy > 10 { drag = dy }
                        }
                        .onEnded { v in
                            let held = Date().timeIntervalSince(pressStart ?? Date())
                            pressStart = nil
                            let dx = v.translation.width, dy = v.translation.height
                            defer { paused = false }
                            if dy > 120, dy > abs(dx) { close(); return }
                            withAnimation(.spring()) { drag = 0 }
                            if abs(dx) > 50, abs(dx) > abs(dy) { if dx < 0 { next() } else { back() }; return }
                            // A tap (not a hold, not a drag).
                            if held < 0.3, abs(dx) < 10, abs(dy) < 10 {
                                if v.startLocation.x < geo.size.width / 3 { back() } else { next() }
                            }
                        })
                // On top of the touch area, so its buttons (the eye, close) get their taps.
                VStack(alignment: .trailing, spacing: 6) {
                    header.padding(.horizontal, 10).padding(.top, 6)
                    // Notes (this view will / won't be sent, reply saved) show just under the eye.
                    if let note {
                        Text(note).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(.black.opacity(0.6), in: Capsule())
                            .padding(.trailing, 10)
                            .transition(.opacity)
                    }
                }
                .zIndex(2)
            }
            .offset(y: max(0, drag))
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
                    // Gray: this view will be sent to Instagram. White: it won't be.
                    if let item {
                        let off = store.isUnreported(item)
                        Button {
                            store.toggleUnreported(item, in: reel)
                            show(off ? "This view will be sent to Instagram" : "This view won't be sent to Instagram")
                        } label: {
                            Image(systemName: "eye.slash").font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(off ? Color.white : Color.white.opacity(0.4))
                                .padding(4)
                        }
                        .accessibilityLabel(off ? "View won't be sent" : "Don't send this view")
                    }
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
