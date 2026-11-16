#!/bin/zsh
# Debug builds: run JavaScript in one tab of the Simulator app and print the result.
# Usage: following/ev.sh home 'document.title'
TAB="$1"; JS="$2"
D=$(xcrun simctl get_app_container "${DEVICE:-iPhone 17}" com.arjankahlon.following data)/Documents
mkdir -p "$D"; rm -f "$D/eval-$TAB.out"
print -r -- "$JS" > "$D/eval-$TAB.js"
for i in {1..20}; do [[ -f "$D/eval-$TAB.out" ]] && { cat "$D/eval-$TAB.out"; echo; exit 0; }; sleep 0.25; done
echo "(no answer: is the $TAB tab open?)"
