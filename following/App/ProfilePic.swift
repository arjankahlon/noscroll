import SwiftUI
import UIKit

/// Your profile picture, as the Profile tab's icon.
///
/// The app keeps the last one it downloaded (Application Support/profile-pic.jpg) and shows it
/// straight away at launch. Each launch, the Home page tells the app the current picture's
/// address once (extras.js, sendProfilePic); the app downloads it a single time and saves it
/// for the next launch.
@MainActor
final class ProfilePic: ObservableObject {
    static let shared = ProfilePic()

    @Published private(set) var image: UIImage?
    private var fetchedThisLaunch = false

    private static var fileURL: URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("profile-pic.jpg")
    }

    private init() {
        if let url = Self.fileURL, let data = try? Data(contentsOf: url), let img = UIImage(data: data) {
            image = Self.icon(from: img)
        }
    }

    func update(from address: String) {
        guard !fetchedThisLaunch, let url = URL(string: address), url.scheme == "https",
              let host = url.host, host.hasSuffix("cdninstagram.com") || host.hasSuffix("fbcdn.net") else { return }
        fetchedThisLaunch = true
        Task {
            guard let (data, _) = try? await URLSession.shared.data(from: url), let img = UIImage(data: data) else {
                fetchedThisLaunch = false
                return
            }
            if let file = Self.fileURL { try? data.write(to: file, options: .atomic) }
            image = Self.icon(from: img)
        }
    }

    /// A round 32-point icon, drawn in its own colours (not tinted like the other tab icons).
    private static func icon(from img: UIImage) -> UIImage {
        let size = CGSize(width: 32, height: 32)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let out = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            let rect = CGRect(origin: .zero, size: size)
            UIBezierPath(ovalIn: rect).addClip()
            let s = img.size
            let side = min(s.width, s.height)
            let scale = size.width / side
            let drawSize = CGSize(width: s.width * scale, height: s.height * scale)
            img.draw(in: CGRect(x: (size.width - drawSize.width) / 2, y: (size.height - drawSize.height) / 2,
                                width: drawSize.width, height: drawSize.height))
        }
        return out.withRenderingMode(.alwaysOriginal)
    }
}
