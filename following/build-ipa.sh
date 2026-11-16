#!/bin/zsh
# Build Following.ipa for a real iPhone on this Mac, without GitHub and without an Xcode project.
# The .ipa is unsigned: SideStore or AltStore signs it with your Apple ID when it installs it.
# Usage: following/build-ipa.sh            -> following/dist/Following.ipa
set -e
cd "$(dirname "$0")"
VERSION="1.0.$(date +%Y%m%d%H%M)"
BUILD="$(date +%Y%m%d%H%M)"
WORK=build/device
APP="$WORK/Payload/Following.app"
rm -rf "$WORK" && mkdir -p "$APP" dist

# Release build: no DEBUG, so the developer hooks (DebugHooks.swift) are left out.
xcrun -sdk iphoneos swiftc -target arm64-apple-ios17.0 -swift-version 5 \
  -O -parse-as-library -module-name Following App/*.swift -o "$APP/Following"

cp Resources/extras.js Resources/privacy-hook.js Resources/instagram.json ../ios/NoScroll/Resources/noscroll.js "$APP/"
xcrun actool Resources/Assets.xcassets --compile "$APP" --platform iphoneos \
  --minimum-deployment-target 17.0 --app-icon AppIcon --output-partial-info-plist "$WORK/partial.plist" >/dev/null

cat > "$APP/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.arjankahlon.following</string>
<key>CFBundleExecutable</key><string>Following</string>
<key>CFBundleName</key><string>Following</string>
<key>CFBundleDisplayName</key><string>Following</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>$BUILD</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>
<key>DTPlatformName</key><string>iphoneos</string>
<key>MinimumOSVersion</key><string>17.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
<key>UILaunchScreen</key><dict/>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array>
<key>UIBackgroundModes</key><array><string>audio</string></array>
<key>ITSAppUsesNonExemptEncryption</key><false/>
<key>NSCameraUsageDescription</key><string>Instagram asks for the camera when you send a photo or video in Messages.</string>
<key>NSMicrophoneUsageDescription</key><string>Instagram asks for the microphone when you record a voice message or video.</string>
<key>NSPhotoLibraryUsageDescription</key><string>Lets you pick photos to send in Messages.</string>
</dict></plist>
EOF
/usr/libexec/PlistBuddy -c "Merge $WORK/partial.plist" "$APP/Info.plist" >/dev/null

(cd "$WORK" && rm -f Following.ipa && zip -qry Following.ipa Payload)
mv "$WORK/Following.ipa" dist/Following.ipa
echo "Built following/dist/Following.ipa (version $VERSION)"
