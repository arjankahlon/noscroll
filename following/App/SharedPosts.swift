import SwiftUI
import Vision
import AVFoundation

/// A post (or reel) that 3 or more people you follow shared to their stories. The story row
/// shows one bubble for it (the page finds them, extras.js), and this viewer shows the post once,
/// with who shared it and what each person added on top: nothing, text, or something else
/// (a poll, link, music, mention, or a drawing or picture).
struct SharedGroup: Identifiable, Decodable {
    let code: String
    let members: [Member]
    var id: String { code }
    /// New reposters first (since you last opened it), then everyone else.
    var ordered: [Member] { members.filter(\.isNew) + members.filter { !$0.isNew } }

    struct Member: Decodable, Identifiable, Equatable {
        let username: String
        let pic: String
        let reelId: String
        let ownerId: String
        let pk: String
        let takenAt: Int
        let url: String      // their story, as a picture
        let vurl: String     // their story, as a video (a shared reel); "" for a picture
        let extras: [String] // Instagram's interactive add-ons on it (Poll, Link, Music...)
        let seen: Bool
        let only: Bool
        let canMark: Bool
        /// Reposted since you last opened this post.
        var fresh: Bool? = nil
        var isNew: Bool { fresh ?? false }
        var id: String { username }
    }
}

@MainActor
final class SharedPosts: ObservableObject {
    static let shared = SharedPosts()
    @Published var group: SharedGroup?

    /// From the story row: open the viewer. Nothing is sent to Instagram: their copies only
    /// count as seen when you watch them in Instagram's own viewer (from their profile).
    func open(_ json: String) {
        guard let d = json.data(using: .utf8), let g = try? JSONDecoder().decode(SharedGroup.self, from: d) else { return }
        group = g
    }

    /// Swiped sideways out of the stack: the person (or stack) before or after it in the row.
    func neighbor(_ code: String, _ dir: Int) {
        group = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            OfflineStories.shared.strip?.webView.evaluateJavaScript("window.__flOpenNeighbor && window.__flOpenNeighbor(\(Self.js(code)), \(dir))")
        }
    }

    private static func js(_ s: String) -> String {
        let d = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data()
        return String((String(data: d, encoding: .utf8) ?? "[\"\"]").dropFirst().dropLast())
    }

    /// Someone's profile, from the list of who reposted it: the viewer closes first.
    func openProfile(_ username: String) {
        group = nil
        guard let url = URL(string: "https://www.instagram.com/\(username)/") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { StoriesModel.current?.open(url) }
    }
}

/// What one person added on top of the shared post.
struct SharedAdded {
    var text: [String] = []
    var other: [String] = []
    /// The part of their copy that's different from the others (what they drew or put on it).
    var crop: UIImage?
    enum Kind { case nothing, text, other }
    var kind: Kind { !other.isEmpty ? .other : !text.isEmpty ? .text : .nothing }
    var detail: String {
        (text + other).joined(separator: ", ")
    }
}

/// Works out what each person added by comparing their copies: Instagram's add-ons come with the
/// story; text is read off each picture (the iPhone's own text recognition), and counts as added
/// when most of the others don't have it (the post's own text is in everyone's copy); anything
/// else that changes the picture (a drawing, a photo, the post moved) shows up against the
/// picture most copies agree on.
@MainActor
final class SharedAnalysis: ObservableObject {
    @Published var images: [String: UIImage] = [:]
    @Published var added: [String: SharedAdded]?

    func run(_ g: SharedGroup) async {
        var imgs: [String: UIImage] = [:]
        var post: UIImage?
        let page = await Self.postPage(g.code)
        await withTaskGroup(of: (String, UIImage?).self) { tg in
            for m in g.members {
                tg.addTask { (m.username, await Self.load(m.url)) }
            }
            // The post itself, as its author posted it: its own text doesn't count as added.
            tg.addTask { ("", await Self.load(page.image)) }
            for await (n, i) in tg {
                if n.isEmpty { post = i } else if let i { imgs[n] = i }
            }
        }
        images = imgs
        let members = g.members
        let cgs = imgs.compactMapValues { $0.cgImage }
        let postCG = post?.cgImage
        let caption = page.caption
        let result = await Task.detached { Self.analyze(members, cgs, postCG, caption) }.value
        added = result
        // The story row's bubble shows the plainest copy.
        if let plain = members.first(where: { result[$0.username]?.kind == .nothing && $0.vurl.isEmpty }),
           let web = OfflineStories.shared.strip?.webView {
            _ = try? await web.callAsyncJavaScript("window.__flGroupPlain && window.__flGroupPlain(code, user)",
                                                   arguments: ["code": g.code, "user": plain.username], contentWorld: .page)
        }
    }

    /// The post's picture and caption, from its page (read by the Home page, which has your
    /// session). The caption counts as the post's own text too: Instagram's other repost layout
    /// shows it on the copy.
    private static func postPage(_ code: String) async -> (image: String, caption: String) {
        guard code.range(of: "^[A-Za-z0-9_-]{5,}$", options: .regularExpression) != nil,
              let web = OfflineStories.shared.home?.webView else { return ("", "") }
        let js = """
        var h = await (await fetch('/p/' + code + '/', { credentials: 'include' })).text();
        var meta = function (p) {
          var m = new RegExp('<meta property="' + p + '" content="([^"]*)"').exec(h);
          if (!m) return '';
          var t = document.createElement('textarea'); t.innerHTML = m[1]; return t.value;
        };
        return JSON.stringify({ image: meta('og:image'), caption: meta('og:description') + ' ' + meta('og:title') });
        """
        guard let s = (try? await web.callAsyncJavaScript(js, arguments: ["code": code], contentWorld: .page)) as? String,
              let d = s.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: String] else { return ("", "") }
        return (o["image"] ?? "", o["caption"] ?? "")
    }

    private static func load(_ s: String) async -> UIImage? {
        guard let url = URL(string: s), let (d, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return UIImage(data: d)
    }

    /// The lines of text on a picture. small: also tiny or uncertain text (left out on a copy:
    /// there it's the post's small print, shrunk, and often misread).
    nonisolated private static func read(_ img: CGImage, small: Bool = true) -> [String] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: img).perform([req])
        return (req.results ?? []).compactMap { o in
            guard let c = o.topCandidates(1).first else { return nil }
            if !small, o.boundingBox.height < 0.018 || c.confidence < 0.4 { return nil }
            return c.string
        }
    }

    nonisolated private static func analyze(_ members: [SharedGroup.Member], _ imgs: [String: CGImage], _ post: CGImage?, _ caption: String) -> [String: SharedAdded] {
        // Text on each copy, as letters and digits only (no spaces, so text that wraps
        // differently still matches). Only lines with words: a lone number or a letter or two is
        // usually part of the post (a score, a jersey number).
        var lines: [String: [(shown: String, key: [Character])]] = [:]
        for (n, img) in imgs {
            lines[n] = read(img, small: false).map { ($0, Array(norm($0))) }.filter { $0.key.filter(\.isLetter).count >= 3 }
        }
        let joined = lines.mapValues { Array($0.flatMap(\.key)) }
        // The post's own text (read from the post at full size, so its small print reads well).
        // (and its caption, from the post's page).
        let imageText = post.map { Array(read($0).flatMap { norm($0) }) } ?? []
        let captionText = Array(norm(caption))
        let postText = imageText + captionText
        // Small gray copies, and the one most copies agree on, pixel by pixel.
        let w = 54, h = 96
        let grays = imgs.compactMapValues { gray($0, w, h) }
        var median = [UInt8](repeating: 0, count: w * h)
        if grays.count >= 3 {
            let all = Array(grays.values)
            for i in 0..<(w * h) {
                let v = all.map { $0[i] }.sorted()
                median[i] = v[v.count / 2]
            }
        }
        var out: [String: SharedAdded] = [:]
        for m in members {
            var a = SharedAdded()
            // An add-on most copies have came with the post (a reel's music), not from them.
            let peers = members.filter { $0.username != m.username }
            a.other = m.extras.filter { e in peers.filter { $0.extras.contains(e) }.count < max(1, peers.count / 2) }
            var otherLayout = false
            if let mine = lines[m.username] {
                let others = joined.filter { $0.key != m.username }.map(\.value)
                // Text that's in the post, or on most of the other copies (like the post's
                // "@author" Instagram puts under it), wasn't added. Close counts: the text reader
                // can misread a letter or two on a small copy.
                let need = max(1, (others.count + 1) / 2)
                let isPost: ([Character]) -> Bool = { k in
                    (!postText.isEmpty && near(k, postText)) || others.filter({ near(k, $0) }).count >= need
                }
                // Instagram's other repost layout (the post with its header and caption) shows
                // the caption: a copy with caption text the others don't have is that layout, and
                // the layout itself isn't something they added.
                // (Word by word: a line can run the caption together with other text.)
                let captionWords = captionText.isEmpty ? 0 : mine.flatMap { $0.shown.split(separator: " ") }.filter { w in
                    let k = Array(norm(String(w)))
                    return k.count >= 5 && near(k, captionText) && !(!imageText.isEmpty && near(k, imageText)) &&
                        others.filter({ near(k, $0) }).count < need
                }.count
                if captionWords >= 2 { otherLayout = true }
                for l in mine where !isPost(l.key) {
                    // A line can run their words together with the post's (its "@author" beside
                    // their text): keep only their words, and drop misread emoji ("=", "*").
                    let words = l.shown.split(separator: " ").map(String.init).filter { w in
                        let k = Array(norm(w))
                        return !k.isEmpty && !(k.count >= 5 && isPost(k))
                    }
                    let kept = words.joined(separator: " ")
                    if norm(kept).filter(\.isLetter).count < 3 { continue }
                    if !a.text.contains(kept) { a.text.append(kept) }
                }
            }
            // (Not for a reel: each copy's still is a different moment of it.)
            if a.text.isEmpty, !otherLayout, m.vurl.isEmpty, grays.count >= 3, let g = grays[m.username] {
                // Differs from the plain copy: first line their copy up with it (the post moved or
                // resized counts as nothing added), then see if anything still differs.
                if changed(g, median, w, h, scale: 1, dx: 0, dy: 0) > 0.02,
                   aligned(g, median, w, h) > 0.02 {
                    a.other.append("Drawing, sticker or picture")
                    if let img = imgs[m.username] { a.crop = UIImage(cgImage: img) }   // their whole copy
                }
            }
            out[m.username] = a
        }
        return out
    }

    /// How much of a copy differs from the plain one (share of the small grid), after moving and
    /// scaling the copy around the middle. Lone specks don't count: only spots with changed
    /// neighbors (a speck is the post's edge, a little off).
    nonisolated private static func changed(_ g: [UInt8], _ ref: [UInt8], _ w: Int, _ h: Int, scale: Double, dx: Int, dy: Int) -> Double {
        let cx = Double(w) / 2, cy = Double(h) / 2
        var v = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                let sx = Int((Double(x) - cx) * scale + cx) + dx, sy = Int((Double(y) - cy) * scale + cy) + dy
                v[y * w + x] = (sx >= 0 && sy >= 0 && sx < w && sy < h) ? g[sy * w + sx] : ref[y * w + x]
            }
        }
        // Only sharp changes count (a sticker, emoji or drawing has edges): a different
        // background or color treatment of the same post changes smoothly and is ignored.
        var diff = [Bool](repeating: false, count: w * h)
        for y in 0..<(h - 1) {
            for x in 0..<(w - 1) {
                let i = y * w + x
                guard abs(Int(v[i]) - Int(ref[i])) > 40 else { continue }
                let edge = max(abs(Int(v[i]) - Int(v[i + 1])), abs(Int(v[i]) - Int(v[i + w])))
                diff[i] = edge > 25
            }
        }
        var n = 0
        for y in 1..<(h - 1) {
            for x in 1..<(w - 1) where diff[y * w + x] {
                var near = 0
                for yy in (y - 1)...(y + 1) { for xx in (x - 1)...(x + 1) where diff[yy * w + xx] { near += 1 } }
                if near >= 3 { n += 1 }
            }
        }
        return Double(n) / Double(w * h)
    }

    /// The least a copy differs once lined up with the plain one: the post moved (up to about a
    /// fifth of the screen) and resized (80% to 125%).
    nonisolated private static func aligned(_ g: [UInt8], _ ref: [UInt8], _ w: Int, _ h: Int) -> Double {
        var best = changed(g, ref, w, h, scale: 1, dx: 0, dy: 0)
        var at = (1.0, 0, 0)
        for scale in stride(from: 0.8, through: 1.25, by: 0.05) {
            for dy in stride(from: -18, through: 18, by: 3) {
                for dx in stride(from: -10, through: 10, by: 2) {
                    let c = changed(g, ref, w, h, scale: scale, dx: dx, dy: dy)
                    if c < best { best = c; at = (scale, dx, dy) }
                }
            }
        }
        // Then finer around the best.
        for scale in stride(from: at.0 - 0.04, through: at.0 + 0.04, by: 0.01) {
            for dy in (at.2 - 2)...(at.2 + 2) {
                for dx in (at.1 - 2)...(at.1 + 2) {
                    best = min(best, changed(g, ref, w, h, scale: scale, dx: dx, dy: dy))
                }
            }
        }
        return best
    }

    /// Whether this text appears somewhere in that text, allowing about one wrong letter in four
    /// (none for a short word).
    nonisolated private static func near(_ pat: [Character], _ text: [Character]) -> Bool {
        let m = pat.count
        guard m > 0 else { return true }
        let k = m < 6 ? 0 : m / 4   // a short word has to match exactly
        var col = Array(0...m)
        for c in text {
            var diag = col[0]
            col[0] = 0
            for i in 1...m {
                let up = col[i]
                col[i] = min(col[i] + 1, col[i - 1] + 1, diag + (pat[i - 1] == c ? 0 : 1))
                diag = up
            }
            if col[m] <= k { return true }
        }
        return false
    }

    nonisolated private static func norm(_ s: String) -> String {
        let kept = s.lowercased().unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : " " }
        return String(kept).split(separator: " ").joined()
    }

    nonisolated private static func gray(_ img: CGImage, _ w: Int, _ h: Int) -> [UInt8]? {
        var px = [UInt8](repeating: 0, count: w * h)
        let ok = px.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        return ok ? px : nil
    }
}

struct SharedPostViewer: View {
    let group: SharedGroup
    @Environment(\.dismiss) private var dismiss
    @StateObject private var an = SharedAnalysis()
    @StateObject private var vid = StoryVideo()
    @State private var showing: String?
    @State private var list = false

    /// Whose copy is on screen: the one you picked, or else a copy with nothing added.
    private var shown: SharedGroup.Member {
        if let showing, let m = group.members.first(where: { $0.username == showing }) { return m }
        // New reposters' copies first, if there are any.
        let pool = group.members.contains(where: \.isNew) ? group.members.filter(\.isNew) : group.members
        if let added = an.added, let m = pool.first(where: { added[$0.username]?.kind == .nothing }) { return m }
        return pool[0]
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black
                .overlay { story.clipShape(RoundedRectangle(cornerRadius: 10)) }
                .ignoresSafeArea()
            // Like Instagram's story viewer: tap the left third or the rest for the previous or next
            // copy in the stack; swipe sideways for the person (or stack) before or after it in
            // the row; swipe down to close; swipe up for who reposted it.
            GeometryReader { geo in
                Color.clear.contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onEnded { v in
                        let dx = v.translation.width, dy = v.translation.height
                        if abs(dy) > abs(dx), dy > 80 { dismiss(); return }
                        if abs(dy) > abs(dx), dy < -60 { list = true; return }
                        if abs(dx) > abs(dy), abs(dx) > 50 { SharedPosts.shared.neighbor(group.code, dx < 0 ? 1 : -1); return }
                        if abs(dx) < 12, abs(dy) < 12 { step(v.location.x < geo.size.width / 3 ? -1 : 1) }
                    })
            }
            .ignoresSafeArea()
            VStack(spacing: 6) {
                // One line per person in the stack, like one per story in Instagram's viewer.
                let order = group.ordered, at = order.firstIndex(of: shown) ?? 0
                HStack(spacing: 3) {
                    ForEach(Array(order.enumerated()), id: \.offset) { i, _ in
                        Capsule().fill(.white.opacity(i <= at ? 0.95 : 0.35)).frame(height: 2.5)
                    }
                }
                .padding(.bottom, 4)
                HStack {
                    Button { list = true } label: {
                        HStack(spacing: 8) {
                            faces
                            Text("Reposted by \(group.members.count)").font(.system(size: 15, weight: .semibold))
                            Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(.black.opacity(0.45), in: Capsule())
                    }
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").font(.system(size: 19, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 40, height: 40).background(.black.opacity(0.45), in: Circle())
                    }
                }
                HStack {
                    Text("\(shown.username)’s copy" + (an.added?[shown.username].map { $0.kind == .nothing ? "" : " · " + $0.detail } ?? ""))
                        .font(.system(size: 13)).foregroundStyle(.white).lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(.black.opacity(0.45), in: Capsule())
                    Spacer()
                }
                Spacer()
            }
            .padding(.horizontal, 14).padding(.top, 22)
        }
        .statusBarHidden()
        .task { await an.run(group) }
        .onAppear { playIfVideo() }
        .onChange(of: shown) { playIfVideo() }
        .onDisappear { vid.show(nil) }
        .sheet(isPresented: $list) {
            SharerList(group: group, added: an.added, shown: shown.username) { showing = $0; list = false }
                .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder private var story: some View {
        if !shown.vurl.isEmpty {
            StoryVideoView(player: vid.player)
        } else if let img = an.images[shown.username] {
            Image(uiImage: img).resizable().scaledToFit()
        } else {
            AsyncImage(url: URL(string: shown.url)) { $0.resizable().scaledToFit() } placeholder: { ProgressView().tint(.white) }
        }
    }

    private var faces: some View {
        HStack(spacing: -8) {
            ForEach(group.ordered.prefix(3)) { m in
                SharerPic(url: m.pic, size: 24).overlay(Circle().stroke(.black, lineWidth: 1.5))
            }
        }
    }

    private func step(_ d: Int) {
        let list = group.ordered
        let i = list.firstIndex(of: shown) ?? 0
        let j = i + d
        // Past either end of the stack: on to the person before or after it in the row.
        if j < 0 || j >= list.count { SharedPosts.shared.neighbor(group.code, d); return }
        showing = list[j].username
    }

    private func playIfVideo() {
        if shown.vurl.isEmpty { vid.show(nil); return }
        vid.show(URL(string: shown.vurl))
        vid.player.play()
    }
}

struct SharerPic: View {
    let url: String
    let size: CGFloat
    var body: some View {
        AsyncImage(url: URL(string: url)) { $0.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.3) }
            .frame(width: size, height: size).clipShape(Circle())
    }
}

/// Everyone who shared the post, by what they added. Tapping someone shows their copy.
struct SharerList: View {
    let group: SharedGroup
    let added: [String: SharedAdded]?
    let shown: String
    let pick: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                if let added {
                    // Reposted since you last opened it: on top (pink), then the ones you've
                    // seen before, each by what they added.
                    let anyNew = group.members.contains(where: \.isNew)
                    sections(added, new: true, heading: anyNew ? ("New since you last opened", Self.instaPink) : nil)
                    sections(added, new: false, heading: anyNew ? ("Previously seen", .primary) : nil)
                } else {
                    Section {
                        HStack(spacing: 10) { ProgressView(); Text("Checking what each person added…").foregroundStyle(.secondary) }
                        ForEach(group.ordered) { row($0, nil) }
                    }
                }
            }
            // Flat and tight, like Instagram's own lists.
            .listStyle(.plain)
            .listSectionSpacing(4)
            .environment(\.defaultMinListRowHeight, 0)
            .contentMargins(.top, 0, for: .scrollContent)
            .navigationTitle("Reposted by \(group.members.count)")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    static let instaPink = Color(red: 225 / 255, green: 48 / 255, blue: 108 / 255)   // #E1306C

    /// New or previously seen ones, by what they added; the big heading (if any) sits on top of
    /// the first of them, not in a section of its own.
    @ViewBuilder
    private func sections(_ added: [String: SharedAdded], new: Bool, heading: (String, Color)?) -> some View {
        let kinds: [(String, SharedAdded.Kind)] = [("Added text", .text), ("Added other things", .other), ("Added nothing", .nothing)]
        let filled = kinds.filter { k in group.members.contains { $0.isNew == new && (added[$0.username] ?? SharedAdded()).kind == k.1 } }
        ForEach(Array(filled.enumerated()), id: \.offset) { i, k in
            section(k.0, k.1, added, new: new, heading: i == 0 ? heading : nil)
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ kind: SharedAdded.Kind, _ added: [String: SharedAdded], new: Bool, heading: (String, Color)?) -> some View {
        let ms = group.members.filter { $0.isNew == new && (added[$0.username] ?? SharedAdded()).kind == kind }
        Section {
            ForEach(ms) { row($0, added[$0.username]).listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16)) }
        } header: {
            VStack(alignment: .leading, spacing: 2) {
                if let heading {
                    Text(heading.0).font(.system(size: 17, weight: .bold)).foregroundStyle(heading.1)
                }
                Text("\(title) (\(ms.count))").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
            }
            .textCase(nil)
            .padding(.vertical, -2)
        }
    }

    private func row(_ m: SharedGroup.Member, _ a: SharedAdded?) -> some View {
        HStack(spacing: 12) {
            // Their picture and name open their profile.
            Button { SharedPosts.shared.openProfile(m.username) } label: { SharerPic(url: m.pic, size: 34) }
                .buttonStyle(.borderless)
            VStack(alignment: .leading, spacing: 2) {
                Button { SharedPosts.shared.openProfile(m.username) } label: {
                    Text(m.username).font(.system(size: 14, weight: .semibold))
                }
                .buttonStyle(.borderless)
                .tint(.primary)   // not iOS's blue
                if let a, a.kind != .nothing {
                    Text(a.detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            // Their whole copy, when they put something on it.
            if let crop = a?.crop {
                Image(uiImage: crop).resizable().scaledToFit()
                    .frame(maxWidth: 80, maxHeight: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            if m.username == shown { Image(systemName: "eye").foregroundStyle(.secondary) }
        }
        // Anywhere else on the row: their copy, in the viewer.
        .contentShape(Rectangle())
        .onTapGesture { pick(m.username) }
    }

}
