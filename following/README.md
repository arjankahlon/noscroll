# Following

A personal Instagram app for iPhone, made from [NoScroll](https://github.com/Blueturboguy07/noscroll)
(AGPL-3.0-or-later). It is Instagram's own mobile web site inside the app, with the NoScroll
engine and this app's own scripts reshaping it.

**Changes from NoScroll** (as the AGPL asks): Instagram only; a new four-tab shell
(`following/App`); no publik sign-in or usage reporting, no onboarding, Screen Time shield or widget;
an editable, unsigned copy of the Instagram rules (`following/Resources/instagram.json`); the app's own
Home feeds, story strip and page tweaks (`following/Resources/extras.js`, `privacy-hook.js`,
`following/App/StoriesStrip.swift`). The engine (`ios/NoScroll/Resources/noscroll.js`) is unchanged.

## Tabs

| Tab | Shows |
| --- | --- |
| Home | Instagram's story row, then **Following** or **Friends** (switch at the top) |
| Search | the search box, no Explore grid |
| Messages | your inbox |
| Profile | your profile (the app learns your username the first time you're signed in) |

- **Following**: Instagram's suggested order (its ranked home feed), only accounts you follow. No
  "Suggested for you" posts, no ads.
- **Friends**: newest first, only private accounts. A rule, not a list, so people you follow later
  are included by themselves.
- **Stories**: Instagram's own story row and viewer, in Instagram's order. Tapping a name in a
  story opens the profile full screen, with a back button.
- Both Home feeds are drawn by the app from Instagram's own feed data: likes (heart or double-tap),
  carousels with a "1/7" counter, video, captions. Profiles, posts and comments open full screen.

Hidden everywhere: Reels, Explore, ads, suggested posts, the New post button, Instagram's own
bottom bar and its "Use the app" banners. Tap a tab you're already on to go back to its start page.
Pull down to refresh.

## Install with SideStore

1. Set up [SideStore](https://sidestore.io) on your iPhone (one time).
2. In SideStore, **Sources > +**, and add
   `https://raw.githubusercontent.com/arjankahlon/noscroll/main/following/source.json`
3. Install **Following**. SideStore re-signs it in the background before the 7 days run out.

Or download `Following.ipa` from the latest release and open it in SideStore or AltStore.

## Making changes

- Hiding rules: `following/Resources/instagram.json` (CSS selectors and blocked addresses).
- Home feeds, stories strip, Instagram's bottom bar, Profile, Search: `following/Resources/extras.js`.
- Reading Instagram's feed data (privacy, feed pages, like requests): `following/Resources/privacy-hook.js`.
- The app itself: `following/App/*.swift`.

Test in the iOS Simulator (needs Xcode): `following/sim.sh` builds a debug copy and launches it.
In debug builds, `following/ev.sh <tab> '<javascript>'` runs JavaScript in a tab and prints the result.

Push to `main` and GitHub Actions (`.github/workflows/build-following.yml`) builds a new `.ipa`,
publishes a release and updates `source.json`; SideStore then offers the update.
