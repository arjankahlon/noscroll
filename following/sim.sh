#!/bin/zsh
# Build a Debug copy of Following for the iOS Simulator and launch it. No Xcode project needed.
# Usage: following/sim.sh ["iPhone 17"]
set -e
cd "$(dirname "$0")"
DEVICE="${1:-iPhone 17}"
APP=build/sim/Following.app
rm -rf build/sim && mkdir -p "$APP"

xcrun -sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator -swift-version 5 \
  -Onone -g -D DEBUG -parse-as-library -module-name Following App/*.swift -o "$APP/Following"

cp Resources/extras.js Resources/privacy-hook.js Resources/instagram.json ../ios/NoScroll/Resources/noscroll.js "$APP/"
xcrun actool Resources/Assets.xcassets --compile "$APP" --platform iphonesimulator \
  --minimum-deployment-target 17.0 --app-icon AppIcon --output-partial-info-plist build/sim/partial.plist >/dev/null

cat > "$APP/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.arjankahlon.following</string>
<key>CFBundleExecutable</key><string>Following</string>
<key>CFBundleName</key><string>Following</string>
<key>CFBundleDisplayName</key><string>Following</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>MinimumOSVersion</key><string>17.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
<key>UILaunchScreen</key><dict/>
<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array>
<key>UIBackgroundModes</key><array><string>audio</string></array>
</dict></plist>
EOF
/usr/libexec/PlistBuddy -c "Merge build/sim/partial.plist" "$APP/Info.plist" >/dev/null
codesign --force --sign - "$APP" 2>/dev/null

xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl install "$DEVICE" "$APP"
xcrun simctl terminate "$DEVICE" com.arjankahlon.following 2>/dev/null || true
xcrun simctl launch "$DEVICE" com.arjankahlon.following
