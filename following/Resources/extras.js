/*
 * Following: extras on top of the NoScroll engine. Runs at document end in each tab.
 *
 * 1. Home goes to the Following feed (/?variant=following), with a loop guard.
 * 2. Ads ("Sponsored" / "Ad") and "Suggested for you" blocks are removed from the feed.
 * 3. Instagram's own bottom bar and its "Use the app" banners are hidden: the app has its own four tabs.
 * 4. The Profile tab finds your username once and opens your profile.
 * 5. The Search tab puts the cursor in the search box.
 * 6. Stories: the strip above the Following feed shows Instagram's own story row (see section 6).
 * 7. Home feeds: a "Following | Friends" switch. Following: Instagram's suggested order, only
 *    accounts you follow. Friends: newest first, only private accounts. Both drawn by the app.
 *
 * Instagram changes its page often. If something stops working, this file and
 * following/Resources/instagram.json are the two places to look.
 */
(function () {
  if (window.__followingExtras) return;
  window.__followingExtras = true;

  var TAB = window.__FOLLOWING_TAB || '';
  // The app's settings (Settings pane, opened from the Following icon on your profile): switches
  // are on unless set to false.
  function S(key) { var f = window.__FL; return !f || f[key] !== false; }
  // Red dates from this many days old (a setting; 3 unless changed).
  var OLD_DAYS = (window.__FL && window.__FL.oldDays > 0) ? window.__FL.oldDays : 3;

  // Colors that follow light and dark mode, for the labels the app adds.
  (function () {
    var st = document.createElement('style');
    st.textContent = ':root{--fl-strong:#000;--fl-muted:#737373}' +
      '@media (prefers-color-scheme: dark){:root{--fl-strong:#f5f5f5;--fl-muted:#a8a8a8}}';
    (document.head || document.documentElement).appendChild(st);
  })();
  // Debugging only: localStorage "following.plain" = "1" or "2" turns these extras off for testing.
  try { if (/^[12]$/.test(localStorage.getItem('following.plain') || '')) return; } catch (e) {}

  function post(msg) {
    try { window.webkit.messageHandlers.following.postMessage(msg); } catch (e) {}
  }

  function isAuthPage() {
    return /^\/(accounts|challenge|oauth|emailsignup)\b/.test(location.pathname) ||
      !!document.querySelector('input[type="password"]');
  }

  /* ---------- 1. Following feed ---------- */
  function followingRedirect() {
    if (location.pathname !== '/' || location.search.indexOf('variant=following') !== -1) return;
    if (location.search.indexOf('following_profile=1') !== -1) return;
    if (TAB === 'stories' || location.search.indexOf('fl_stories=') !== -1) return;
    if (isAuthPage()) return;
    // Guard: at most 3 redirects in 20 s, so a change on Instagram's side can never trap you in a loop.
    var now = Date.now(), log = [];
    try { log = JSON.parse(sessionStorage.getItem('following.redirects') || '[]'); } catch (e) {}
    log = log.filter(function (t) { return now - t < 20000; });
    if (log.length >= 3) return;
    log.push(now);
    try { sessionStorage.setItem('following.redirects', JSON.stringify(log)); } catch (e) {}
    // Only Home shows a feed. In the other tabs (where Instagram's Back button, or a logo, can
    // lead to its home page) the tab goes back to its own start page instead.
    location.replace(TAB_START[TAB] || '/?variant=following');
  }
  var TAB_START = { search: S('explorePage') ? '/explore/' : '/explore/search/', messages: '/direct/inbox/', profile: '/?following_profile=1' };

  // Instagram's Back button goes to its home page when the page was opened directly (no earlier
  // page it knows of). Outside Home, Back goes back to the page before instead, as expected.
  document.addEventListener('click', function (e) {
    if (TAB === 'home' || TAB === 'stories' || !TAB_START[TAB]) return;
    var svg = e.target && e.target.closest && e.target.closest('[role="button"],button,a');
    if (!svg || !svg.querySelector('svg[aria-label="Back"]') || history.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    history.back();
  }, true);

  /* ---------- 2. Ads and suggestions ---------- */
  var AD_WORDS = { 'Sponsored': 1, 'Ad': 1, 'Paid partnership': 0 };
  var SUGGESTED = /^(Suggested for you|Suggested posts|Suggested Reels)$/i;

  function leafTexts(root, limit) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var n, count = 0;
    while ((n = walker.nextNode()) && count < limit) {
      var t = (n.nodeValue || '').trim();
      if (t) { out.push([t, n.parentElement]); count++; }
    }
    return out;
  }

  // Hide, never remove: these nodes belong to Instagram's own code. Removing one makes it
  // rebuild the feed from the top later, which throws you back to the first post.
  function hideNode(el) {
    el.style.setProperty('display', 'none', 'important');
  }

  function cleanFeed() {
    var articles = document.querySelectorAll('article');
    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      if (a.dataset.followingChecked === '1' && a.dataset.followingSeen === String(a.textContent.length)) continue;
      a.dataset.followingChecked = '1';
      a.dataset.followingSeen = String(a.textContent.length);
      // The ad label sits in the post's header, near the top: only the first few texts are checked.
      var texts = leafTexts(a, 12);
      for (var j = 0; j < texts.length; j++) {
        var t = texts[j][0];
        if (AD_WORDS[t] === 1 || SUGGESTED.test(t)) { hideNode(a); break; }
      }
    }
    // "Suggested for you" account carousels that are not inside an <article>.
    var spans = document.querySelectorAll('main span, main div[dir="auto"], main h2, main h3');
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k];
      if (s.closest('[style*="display: none"]')) continue;
      if (s.children.length || !SUGGESTED.test((s.textContent || '').trim())) continue;
      var box = s.closest('article') || blockAround(s);
      if (box) hideNode(box);
    }
  }

  // The smallest ancestor that looks like a feed block (wider than tall-ish, under a screen high).
  function blockAround(el) {
    var node = el, best = null;
    for (var d = 0; d < 8 && node && node !== document.body; d++) {
      node = node.parentElement;
      if (!node || node.tagName === 'MAIN') break;
      // Never a box that also holds the page's header: on a private profile you don't follow,
      // "Suggested for you" sits right under the profile, and the whole page is shorter than the
      // screen, so climbing further would hide the profile itself.
      if (node.querySelector('header')) break;
      var r = node.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.9) break;
      if (r.width >= window.innerWidth * 0.9) best = node;
    }
    return best;
  }

  /* ---------- 3. Instagram's own bottom bar ---------- */
  var bottomBar = null;

  function findBottomBar() {
    if (bottomBar && document.contains(bottomBar)) return bottomBar;
    // Instagram's bar is the last row of a full-height column (not position: fixed). Start at an
    // icon in the bottom half of the screen and climb to the largest box that is still a short,
    // full-width strip touching the bottom edge.
    var vh = window.innerHeight, vw = window.innerWidth;
    var icons = document.querySelectorAll('svg[aria-label="Home"], a[href="/direct/inbox/"], a[href="/"]');
    for (var i = 0; i < icons.length; i++) {
      var start = icons[i].getBoundingClientRect();
      if (start.top < vh / 2 || start.height === 0) continue;
      var node = icons[i], best = null;
      for (var d = 0; d < 14 && node && node !== document.body; d++) {
        var r = node.getBoundingClientRect();
        // 220: the bar plus the space Instagram adds under it for the home indicator.
        if (r.height > 220) break;
        if (r.bottom >= vh - 4 && r.width >= vw * 0.9) best = node;
        node = node.parentElement;
      }
      if (best) { bottomBar = best; return best; }
    }
    return null;
  }

  function hideBottomBar() {
    var bar = findBottomBar();
    if (bar && bar.style.display !== 'none') bar.style.setProperty('display', 'none', 'important');
  }

  /* ---------- 3b. "Use the app" banners ---------- */
  var APP_PROMPT = /^(Use the app|Open app|Open the app|Get the app|Open Instagram)$/i;

  function hideAppPrompts() {
    var els = document.querySelectorAll('button, a, span, div[role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length > 1 || !APP_PROMPT.test((el.textContent || '').trim())) continue;
      // Hide the fixed strip it sits in; a lone button elsewhere just goes.
      var node = el, target = el;
      for (var d = 0; d < 6 && node && node !== document.body; d++) {
        if (getComputedStyle(node).position === 'fixed') { target = node; break; }
        node = node.parentElement;
      }
      target.style.setProperty('display', 'none', 'important');
    }
  }

  /* ---------- 4. Profile ---------- */
  var sentUser = false;

  function findUsername() {
    var bar = findBottomBar();
    var scope = bar || document;
    var imgs = scope.querySelectorAll('a[href] img[alt]');
    for (var i = 0; i < imgs.length; i++) {
      var m = /^(.+?)'s profile picture$/.exec(imgs[i].getAttribute('alt') || '');
      var link = imgs[i].closest('a');
      if (!m || !link) continue;
      var href = link.getAttribute('href') || '';
      var hm = /^\/([A-Za-z0-9._]{1,30})\/?$/.exec(href);
      if (hm && hm[1] === m[1]) return hm[1];
      if (bar && hm) return hm[1];
    }
    return null;
  }

  // Your profile picture, for the Profile tab's icon (the app keeps a copy, see ProfilePic.swift).
  var sentPic = false;
  function sendProfilePic() {
    if (sentPic || TAB !== 'home') return;
    var html = document.documentElement.innerHTML;
    var i = html.indexOf('"PolarisViewer"');
    if (i === -1) return;
    var m = /"profile_pic_url":"([^"]+)"/.exec(html.slice(i, i + 6000));
    if (!m) return;
    var url;
    try { url = JSON.parse('"' + m[1] + '"'); } catch (e) { return; }
    if (!/^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//.test(url)) return;
    sentPic = true;
    post({ type: 'profilePic', value: url });
  }

  function profileStep() {
    sendProfilePic();
    if (sentUser && TAB !== 'profile') return;
    var user = findUsername();
    if (!user) return;
    if (!sentUser) { post({ type: 'username', value: user }); sentUser = true; sendProfilePic(); }
    if (TAB === 'profile' && location.search.indexOf('following_profile=1') !== -1) {
      location.replace('/' + user + '/');
    }
  }

  /* ---------- 5. Search ---------- */
  // Marks the Search page on <html> so rules in instagram.json can apply to it alone
  // (the engine's CSS rules otherwise apply on every page).
  function routeMarkStep() {
    var route = location.pathname.indexOf('/explore/search') === 0 ? 'search' : '';
    var root = document.documentElement;
    if ((root.getAttribute('data-fl-route') || '') !== route) {
      if (route) root.setAttribute('data-fl-route', route); else root.removeAttribute('data-fl-route');
    }
  }

  var focused = false;
  function focusSearch() {
    if (focused || TAB !== 'search' || location.pathname.indexOf('/explore/search') !== 0) return;
    var input = document.querySelector('input[type="search"], input[placeholder*="Search" i], input[aria-label*="Search" i]');
    if (input) { input.focus(); focused = true; }
  }

  /* ---------- 6. Stories ---------- */
  // The stories are Instagram's own story row, shown by a separate small browser (the "stories"
  // strip, see StoriesStrip.swift) that sits above the Following feed. Instagram's web Following
  // page has no stories, and its For You page does: so the strip loads the For You page, hides
  // everything on it except the story row, and the app lays it over a gap left at the top of the
  // Following feed. Tapping a story opens Instagram's own viewer, in Instagram's own order.

  function onFollowingFeed() {
    return location.pathname === '/' && location.search.indexOf('variant=following') !== -1;
  }

  // Home tab: leave a gap above the "Following" title for the strip. The app sets its height
  // (--fl-tray) once the strip has measured Instagram's story row.
  function spacerStep() {
    if (TAB !== 'home' || !onFollowingFeed()) return;
    var header = document.querySelector('header');
    var anchor = (header && header.closest('nav')) || document.querySelector('main');
    if (!anchor || !anchor.parentElement) return;
    // The "Following" title bar normally stays pinned; let it scroll with the stories and feed.
    if (header && header.style.position !== 'relative') header.style.setProperty('position', 'relative', 'important');
    var sp = document.getElementById('fl-tray-spacer');
    if (sp && sp.nextElementSibling === anchor) return;
    if (sp) sp.remove();
    sp = document.createElement('div');
    sp.id = 'fl-tray-spacer';
    sp.style.height = 'var(--fl-tray, 0px)';
    sp.style.flexShrink = '0';
    anchor.parentElement.insertBefore(sp, anchor);
  }

  // Stories strip: keep only Instagram's story row on the page.
  var isolated = [], stripBox = null, lastHeight = 0;
  var storySeen = {};

  function restoreStrip() {
    for (var i = isolated.length - 1; i >= 0; i--) {
      var e = isolated[i];
      if (e[1] === null) e[0].removeAttribute('style'); else e[0].setAttribute('style', e[1]);
    }
    isolated = [];
    stripBox = null;
    var c = document.getElementById('fl-story-count');
    if (c) c.remove();
    var v = document.getElementById('fl-offline');
    if (v) v.remove();
    var vl = document.getElementById('fl-version');
    if (vl) vl.remove();
  }
  function versionLabel() {
    if (document.getElementById('fl-version') || !window.__FOLLOWING_VERSION) return;
    var v = document.createElement('div');
    v.id = 'fl-version';
    v.style.cssText = 'position:absolute;top:1px;right:14px;z-index:5;font:700 17px/21px -apple-system,system-ui,sans-serif;color:var(--fl-strong);pointer-events:none';
    v.textContent = 'Following v' + window.__FOLLOWING_VERSION;
    document.body.appendChild(v);
  }

  function hideForStrip(el) {
    isolated.push([el, el.getAttribute('style')]);
    el.style.setProperty('display', 'none', 'important');
  }

  function stripStep() {
    if (TAB !== 'stories') return;
    if (location.pathname !== '/') {
      // Instagram's story viewer is open: show the page as it is. Opening someone's stories
      // shows you at least one, so they count as seen.
      var sv = /^\/stories\/([^/]+)\//.exec(location.pathname);
      if (sv && sv[1] !== 'highlights') storySeen[decodeURIComponent(sv[1])] = true;
      if (isolated.length) restoreStrip();
      return;
    }
    var first = document.querySelector('[role="button"][aria-label^="Story by "]');
    if (!first) return;
    // The row: the outermost full-width box around the first story that is no taller than the
    // row itself (plus a little padding). Checked every time, because Instagram can load its
    // feed into a box that was only the row a moment ago.
    var rowHeight = first.getBoundingClientRect().height;
    // Keep the box already chosen while it still holds the row and is still only the row.
    // (Once the page is trimmed, higher boxes also look like "only the row"; switching to them
    // would undo and redo the trimming forever.)
    if (stripBox && document.contains(stripBox) && stripBox.contains(first) &&
        stripBox.getBoundingClientRect().height <= rowHeight + 40) {
      reportStripHeight(stripBox);
      return;
    }
    var box = null, n = first;
    while (n && n !== document.body) {
      var r = n.getBoundingClientRect();
      if (r.height > rowHeight + 40) break;
      if (r.width >= window.innerWidth * 0.95) box = n;
      n = n.parentElement;
    }
    if (!box) return;
    if (box !== stripBox || !document.contains(stripBox)) {
      restoreStrip();
      stripBox = box;
      for (var a = box; a && a !== document.body; a = a.parentElement) {
        var p = a.parentElement;
        if (!p) break;
        for (var i = 0; i < p.children.length; i++) {
          var s = p.children[i];
          if (s !== a && s.tagName !== 'STYLE' && s.tagName !== 'SCRIPT' && s.tagName !== 'LINK') hideForStrip(s);
        }
        isolated.push([a, a.getAttribute('style')]);
        a.style.setProperty('padding-top', '0', 'important');
        a.style.setProperty('margin-top', '0', 'important');
        a.style.setProperty('min-height', '0', 'important');
        a.style.setProperty('top', '0', 'important');
      }
      reportStripHeight(box);
      // Trimmed to the row: the app can show it again (it hides it while it comes back).
      post({ type: 'stripReady' });
      return;
    }
    reportStripHeight(box);
  }

  // Load all stories: the app downloads every photo story you haven't watched (videos are left
  // alone), so they can be watched without signal. The app draws its progress here
  // (window.__flOfflineState); offline, tapping someone with saved stories opens the app's viewer.
  var offlineState = { phase: 'idle', saved: 0, offline: false, users: [] };
  // A cloud with a download arrow (like the App Store's download icon), and once saved, the
  // download arrow in a circle.
  var ICON_DOWN = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/></svg>';
  var ICON_SAVED = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="m8 12 4 4 4-4"/></svg>';
  var ICON_OFF = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.8a15 15 0 0 1 4.2-2.7M9.5 5.2A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 5-2.6M14.5 10.2a10 10 0 0 1 4.5 2.3M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/></svg>';
  function offlineButton() {
    var v = document.getElementById('fl-offline');
    if (!v) {
      v = document.createElement('div');
      v.id = 'fl-offline';
      v.style.cssText = 'position:absolute;top:0;right:14px;z-index:5;display:flex;align-items:center;gap:7px;font:600 15px/22px -apple-system,system-ui,sans-serif;color:var(--fl-strong);pointer-events:none';
      var b = document.createElement('span');
      b.className = 'btn';
      b.setAttribute('role', 'button');
      b.style.cssText = 'pointer-events:auto;display:inline-flex;align-items:center;gap:5px;cursor:pointer;-webkit-tap-highlight-color:transparent';
      b.__flTap = function () { post({ type: 'offlineTap' }); };
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); b.__flTap(); });
      v.appendChild(b);
      // The download's progress: a thin bar under the button, only while loading.
      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.cssText = 'position:absolute;right:0;top:23px;width:100%;height:3px;border-radius:2px;background:rgba(127,127,127,.25);overflow:hidden;display:none';
      var fill = document.createElement('div');
      fill.style.cssText = 'height:100%;width:0;background:#0095f6;border-radius:2px;transition:width .2s';
      bar.appendChild(fill);
      v.appendChild(bar);
      document.body.appendChild(v);
    }
    drawOffline();
    grayRings();
    offlineRow();
  }
  // Offline: the app's own copy of the story row (Instagram's only shows a few people at a
  // time and can't be reordered): people with saved stories first, in the usual order, then
  // everyone with only videos (not saved), dimmed. Tapping someone saved opens the viewer.
  // Instagram's repost icon (its "Repost" button).
  var REPOST_PATH = 'M19.998 9.497a1 1 0 0 0-1 1v4.228a3.274 3.274 0 0 1-3.27 3.27h-5.313l1.791-1.787a1 1 0 0 0-1.412-1.416L7.29 18.287a1.004 1.004 0 0 0-.294.707v.001c0 .023.012.042.013.065a.923.923 0 0 0 .281.643l3.502 3.504a1 1 0 0 0 1.414-1.414l-1.797-1.798h5.318a5.276 5.276 0 0 0 5.27-5.27v-4.228a1 1 0 0 0-1-1Zm-6.41-3.496-1.795 1.795a1 1 0 1 0 1.414 1.414l3.5-3.5a1.003 1.003 0 0 0 0-1.417l-3.5-3.5a1 1 0 0 0-1.414 1.414l1.794 1.794H8.27A5.277 5.277 0 0 0 3 9.271V13.5a1 1 0 0 0 2 0V9.271a3.275 3.275 0 0 1 3.271-3.27Z';
  function offlineRow() {
    var row = document.getElementById('fl-offrow');
    var st = offlineState;
    var show = S('offlineStories') && TAB === 'stories' && location.pathname === '/' && st.offline && (st.users || []).length > 0;
    if (!show) { if (row) row.remove(); return; }
    var me = (document.cookie.match(/(?:^|; )ds_user_id=(\d+)/) || [])[1] || '';
    var tray = (window.__flTray || []).filter(function (r) { return String((r.user || {}).pk) !== me; });
    var saved = st.users || [], watched = st.watched || [];
    var people = [];
    // Saved and not yet watched, then saved and watched (as Instagram moves seen ones back),
    // then video-only.
    var savedUsers = [];
    tray.forEach(function (r) { var u = r.user || {}; if (saved.indexOf(u.username) !== -1) savedUsers.push(u); });
    saved.forEach(function (n) { if (!savedUsers.some(function (u) { return u.username === n; })) savedUsers.push({ username: n }); });
    savedUsers.forEach(function (u) { if (watched.indexOf(u.username) === -1) people.push(u); });
    savedUsers.forEach(function (u) { if (watched.indexOf(u.username) !== -1) people.push(u); });
    // Not saved: still unseen, but only shared posts (repost mark) or videos (play mark), the
    // shared-post ones first; then people already seen before going offline (last, like
    // Instagram's seen ones, with a gray ring and no mark).
    var skipKinds = {};
    try { skipKinds = JSON.parse(localStorage.getItem('following.offSkip') || '{}') || {}; } catch (e) {}
    var seenBefore = {}, onlyPosts = [], onlyVideos = [];
    tray.forEach(function (r) {
      var u = r.user || {};
      if (saved.indexOf(u.username) !== -1) return;
      if (r.seen && r.seen >= r.latest_reel_media) seenBefore[u.username] = true;
      else (skipKinds[u.username] === 'post' ? onlyPosts : onlyVideos).push(u);
    });
    people = people.concat(onlyPosts, onlyVideos);
    tray.forEach(function (r) { var u = r.user || {}; if (seenBefore[u.username]) people.push(u); });
    var key = JSON.stringify([saved, watched, people.length, Object.keys(st.pics || {}).length]);
    if (row && row.__key === key) return;
    if (!row) {
      row = document.createElement('div');
      row.id = 'fl-offrow';
      row.style.cssText = 'position:absolute;left:0;top:24px;width:100%;height:124px;z-index:4;display:flex;overflow-x:auto;overflow-y:hidden;' +
        'padding-left:9px;box-sizing:border-box;-webkit-overflow-scrolling:touch;scrollbar-width:none;background:' + (getComputedStyle(document.body).backgroundColor || '#fff');
      document.body.appendChild(row);
    }
    row.__key = key;
    row.innerHTML = '';
    people.forEach(function (u) {
      var has = saved.indexOf(u.username) !== -1, done = watched.indexOf(u.username) !== -1;
      var it = document.createElement('div');
      it.className = 'fl-offitem';
      var before = !!seenBefore[u.username];
      it.style.cssText = 'flex:none;width:102px;display:flex;flex-direction:column;align-items:center;padding-top:5px;' + (has ? '' : before ? 'opacity:.55;' : 'opacity:.35;');
      var ring = document.createElement('div');
      ring.style.cssText = 'width:89px;height:89px;border-radius:50%;box-sizing:border-box;padding:' + (has && !done ? '3px' : '2px') + ';background:' +
        (has && !done ? 'linear-gradient(to top right,#FFD600 0%,#FF7A00 28%,#FF0069 58%,#D300C5 100%)' : '#c7c7c7');
      var inner = document.createElement('div');
      inner.style.cssText = 'width:100%;height:100%;border-radius:50%;padding:3px;box-sizing:border-box;background:' + row.style.background;
      var img = document.createElement('div');
      // The saved picture first (Instagram's can't load offline), then Instagram's.
      var picUrl = (st.pics || {})[u.username] || u.profile_pic_url;
      img.style.cssText = 'width:100%;height:100%;border-radius:50%;background:#dbdbdb center/cover no-repeat' +
        (picUrl ? ';background-image:url("' + picUrl + '")' : '');
      inner.appendChild(img);
      ring.appendChild(inner);
      it.appendChild(ring);
      var name = document.createElement('div');
      // Nothing saved (and not seen before): a play mark for videos, the repost mark when
      // their stories share posts.
      if (!has && !before && skipKinds[u.username] === 'post') {
        name.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="vertical-align:-1px;margin-right:3px"><path d="' + REPOST_PATH + '"/></svg>';
        name.appendChild(document.createTextNode(u.username || ''));
      } else name.textContent = (has || before ? '' : '▶︎ ') + (u.username || '');
      name.style.cssText = 'margin-top:6px;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:400 13px/16px -apple-system,system-ui,sans-serif;color:var(--fl-strong)';
      it.appendChild(name);
      if (has) it.__flTap = function () { post({ type: 'openOffline', value: u.username }); };
      row.appendChild(it);
    });
  }
  // Apple's symbol for the state (sent by the app), tinted like the text; the drawn ones if not.
  function sym(name, fallback) {
    var d = (offlineState.icons || {})[name];
    if (!d) return fallback;
    var parts = d.split('|'), wh = (parts[1] || '20x18').split('x');
    return '<span style="display:inline-block;width:' + wh[0] + 'px;height:' + wh[1] + 'px;background:currentColor;' +
      '-webkit-mask:url(' + parts[0] + ') center/contain no-repeat;mask:url(' + parts[0] + ') center/contain no-repeat"></span>';
  }
  function drawOffline() {
    var v = document.getElementById('fl-offline');
    if (!v) return;
    var b = v.querySelector('.btn'), bar = v.querySelector('.bar'), st = offlineState, html, color = '';
    var n = st.saved || 0;
    if (st.phase === 'loading') {
      html = sym('down', ICON_DOWN) + '<span>' + (st.total ? 'Loading ' + st.done + ' of ' + st.total : 'Finding stories…') + '</span>';
    } else if (st.phase === 'failed') {
      html = sym('down', ICON_DOWN) + '<span>' + (st.message || "Couldn't load") + '</span>';
      color = '#ed4956';
    } else if (st.offline) {
      html = sym('off', ICON_OFF) + '<span>' + (n ? 'Offline · ' + n + ' available' : 'Offline') + '</span>';
      color = '#e07a00';
    } else if (n) {
      html = sym('saved', ICON_SAVED) + '<span>' + n + ' available offline</span>';
      color = '#1f9d55';
    } else {
      html = sym('down', ICON_DOWN) + '<span>Load offline stories</span>';
    }
    if (b.__html !== html) { b.innerHTML = html; b.__html = html; }
    b.style.color = color;
    var loading = st.phase === 'loading' && st.total > 0;
    bar.style.display = loading ? 'block' : 'none';
    bar.firstChild.style.width = loading ? Math.round(100 * st.done / st.total) + '%' : '0';
  }
  window.__flOfflineState = function (st) {
    offlineState = st || offlineState;
    drawOffline();
    grayRings();
    // Stories watched offline count as seen in "x/y stories seen" right away.
    if (stripBox) reportStripHeight(stripBox);
    offlineRow();
  };
  // Instagram's own viewer moves from person to person without loading a page: note each one
  // the moment it opens, so the count is right as soon as the viewer closes.
  if (TAB === 'stories') {
    ['pushState', 'replaceState'].forEach(function (k) {
      var orig = history[k];
      history[k] = function () {
        var r = orig.apply(this, arguments);
        var sv = /^\/stories\/([^/]+)\//.exec(location.pathname);
        if (sv && sv[1] !== 'highlights') storySeen[decodeURIComponent(sv[1])] = true;
        return r;
      };
    });
  }
  // Everyone whose saved stories you've all watched offline: their ring goes gray right away
  // (Instagram's row only learns about it once you're back online).
  function grayRings() {
    var done = offlineState.watched || [];
    [].forEach.call(document.querySelectorAll('[role="button"][aria-label^="Story by "]'), function (b) {
      var m = /^Story by (.+?), (?:seen|not seen)$/.exec(b.getAttribute('aria-label') || '');
      var ring = b.querySelector('canvas');
      if (!m || !ring) return;
      var gray = done.indexOf(m[1]) !== -1;
      if (gray !== !!ring.__flGray) {
        ring.__flGray = gray;
        if (gray) ring.style.setProperty('filter', 'grayscale(1) opacity(.4)', 'important');
        else ring.style.removeProperty('filter');
      }
    });
  }
  // Offline: tapping someone whose stories are saved opens them in the app's viewer instead of
  // Instagram's (which can't load without signal).
  if (TAB === 'stories') {
    document.addEventListener('click', function (e) {
      if (!offlineState.offline || !S('offlineStories')) return;
      var s = e.target && e.target.closest && e.target.closest('[role="button"][aria-label^="Story by "]');
      if (!s) return;
      var m = /^Story by (.+?), (?:seen|not seen)$/.exec(s.getAttribute('aria-label') || '');
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (m && offlineState.users.indexOf(m[1]) !== -1) post({ type: 'openOffline', value: m[1] });
    }, true);
  }
  // The list for the app to download: everyone in the story row with something you haven't
  // watched, and their unwatched photo stories (largest size), asked for the way Instagram's own
  // story viewer asks (it doesn't mark anything as seen).
  window.__flOfflineList = async function () {
    var me = (document.cookie.match(/(?:^|; )ds_user_id=(\d+)/) || [])[1] || '';
    var tray = (window.__flTray || []).filter(function (r) {
      return String((r.user || {}).pk) !== me && !(r.seen >= r.latest_reel_media);
    });
    var out = [], skipKind = {};
    for (var i = 0; i < tray.length; i += 20) {
      var ids = tray.slice(i, i + 20).map(function (r) { return String(r.id); });
      var d = await gqlRequest('PolarisStoriesV3ReelPageStandaloneQuery', '39989351314045574', {
        reel_ids_arr: ids, is_highlight: false, media_id: null,
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: false });
      var rs = (d.xdt_api__v1__feed__reels_media || {}).reels_media || [];
      rs.forEach(function (r) {
        var t = tray.filter(function (x) { return String(x.id) === String(r.id); })[0] || {};
        var u = r.user && r.user.username ? r.user : (t.user || {});
        // Who gets saved: anyone with at least one unwatched photo story of their own (not a
        // video, and not one that shares a post or reel: story_feed_media, the post's card).
        // For them, everything unwatched is saved: photos, shared posts and videos (videos go
        // to the end of the download queue). Why someone else has nothing saved is remembered
        // for the row (a play mark for videos, a repost mark for shared posts).
        var unseen = (r.items || []).filter(function (it) { return !(r.seen >= it.taken_at); });
        var shared = function (it) { return (it.story_feed_media || []).length > 0; };
        var eligible = unseen.some(function (it) { return it.media_type === 1 && !shared(it); });
        var name0 = (r.user && r.user.username) || ((t.user || {}).username) || '';
        if (name0) skipKind[name0] = eligible ? '' : unseen.some(function (it) { return it.media_type !== 1 && !shared(it); }) ? 'video' :
          unseen.some(shared) ? 'post' : '';
        var items = (eligible ? unseen : [])
          .map(function (it) {
            var c = ((it.image_versions2 || {}).candidates || [])[0] || {};
            var v = it.media_type === 2 ? ((it.video_versions || [])[0] || {}) : null;
            var mu = ((it.story_music_stickers || [])[0] || {}).music_asset_info;
            return { id: String(it.id), pk: String(it.pk), takenAt: it.taken_at || 0, expiresAt: it.expiring_at || 0,
              url: v ? (v.url || '') : (c.url || ''), video: !!v, duration: v ? (it.video_duration || 0) : 0,
              w: c.width || 1080, h: c.height || 1920, liked: !!it.has_liked,
              music: !v && mu && mu.title ? mu.title + (mu.display_artist ? ' · ' + mu.display_artist : '') : null };
          }).filter(function (it) { return it.url; });
        if (items.length) out.push({ reelId: String(r.id), userId: String(u.pk || u.id || r.id), username: u.username || '',
          pic: u.profile_pic_url || '', items: items });
      });
    }
    try { localStorage.setItem('following.offSkip', JSON.stringify(skipKind)); } catch (e) {}
    return JSON.stringify(out);
  };

  // The app: is the orange banner showing? It has its own (i), so the one here hides.
  window.__flSetBanner = function (on) {
    window.__flBanner = !!on;
    var i = document.querySelector('#fl-offline .info');
    if (i) i.style.display = on ? 'none' : 'inline-flex';
  };

  // Above the row: how many of the people with stories up you've watched ("Stories: 12/120
  // seen"). Counted per person: watching any one of their current stories counts. From
  // Instagram's list for the row ("seen" is when the last story you watched was posted, so
  // within the last day means one that is still up), plus the stories you open here.
  // And "Your story" (Instagram always shows it, with a +) only while you have a story up.
  function storyExtras(box, first) {
    var tray = window.__flTray;
    var row = first.parentElement;
    var me = (document.cookie.match(/(?:^|; )ds_user_id=(\d+)/) || [])[1] || '';
    var own = row && row.firstElementChild;
    if (own && own !== first && !/^Story by /.test(own.getAttribute('aria-label') || '')) {
      var active = !!own.querySelector('canvas') ||
        !!(tray && tray.some(function (r) { return String((r.user || {}).pk) === me; }));
      if (active) own.style.removeProperty('display');
      else own.style.setProperty('display', 'none', 'important');
    }
    if (!tray) return;
    var labels = document.querySelectorAll('[role="button"][aria-label^="Story by "]');
    for (var i = 0; i < labels.length; i++) {
      var lm = /^Story by (.+), (seen|not seen)$/.exec(labels[i].getAttribute('aria-label') || '');
      if (lm && lm[2] === 'seen') storySeen[lm[1]] = true;
    }
    var total = 0, seenN = 0, dayAgo = Date.now() / 1000 - 86400;
    tray.forEach(function (r) {
      var u = r.user || {};
      if (String(u.pk) === me) return;
      total++;
      if ((r.seen && (r.seen >= r.latest_reel_media || r.seen > dayAgo)) || storySeen[u.username] ||
          (offlineState.watchedAny || []).indexOf(u.username) !== -1) seenN++;
    });
    var c = document.getElementById('fl-story-count');
    if (!c) {
      c = document.createElement('div');
      c.id = 'fl-story-count';
      c.style.cssText = 'position:absolute;top:4px;left:14px;z-index:5;font:600 12px/16px -apple-system,system-ui,sans-serif;color:#737373;pointer-events:none';
      document.body.appendChild(c);
    }
    // And on the right of the same line: Load offline stories (for a stretch without signal), or
    // with offline stories switched off in App settings, which version of the app this is.
    if (S('offlineStories')) offlineButton(); else versionLabel();
    var text = S('storyCount') ? seenN + '/' + total + ' stories seen' : '';
    c.style.display = text ? '' : 'none';
    if (c.textContent !== text) {
      c.textContent = text;
      // The app passes it on to the Home feed, for under "You're all caught up".
      post({ type: 'storyCount', value: text });
    }
    // Room for the count above the circles.
    box.style.setProperty('padding-top', '24px', 'important');
  }

  // Pull to refresh from the story row: this small browser keeps the drag, so it tells the app
  // when you pull down on it (the app refreshes Home if the feed is at the top).
  var pullFrom = null, pulled = false;
  if (TAB === 'stories') {
    document.addEventListener('touchstart', function (e) {
      var t = e.touches && e.touches[0];
      pullFrom = t && location.pathname === '/' ? { x: t.clientX, y: t.clientY } : null;
      pulled = false;
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', function (e) {
      var t = e.touches && e.touches[0];
      if (!pullFrom || pulled || !t) return;
      var dy = t.clientY - pullFrom.y, dx = Math.abs(t.clientX - pullFrom.x);
      if (dy > 70 && dy > dx * 2) { pulled = true; post({ type: 'pullRefresh' }); }
    }, { capture: true, passive: true });
  }

  function reportStripHeight(box) {
    var firstStory = document.querySelector('[role="button"][aria-label^="Story by "]');
    if (firstStory) storyExtras(box, firstStory);
    var h = Math.round(box.getBoundingClientRect().height);
    if (h > 40 && h < 260 && h !== lastHeight) {
      lastHeight = h;
      post({ type: 'trayHeight', value: h });
    }
  }

  /* ---------- 7. Friends feed ---------- */
  // "Following | Friends" next to each other at the top of the Home feed. Friends shows only posts
  // from private accounts: a rule, not a list, so people you follow later are included by
  // themselves. Friends is newest first; Following is in Instagram's suggested order, with only
  // accounts you follow (see FEEDS below).
  //
  // Both feeds are drawn by the app, not by hiding posts inside Instagram's list (Instagram's list
  // works out what to draw from post heights, and hidden posts break that). privacy-hook.js keeps
  // every page of the Following feed Instagram receives, with each post's author and whether the
  // account is private. Friends draws the private accounts' posts from those pages, and asks for
  // the next page by repeating Instagram's own "load more" request with the next cursor.
  // Posts, profiles and comments open full screen over the feed (the stories layer), so you keep
  // your place.
  // Friends is the default: each launch opens on it. A switch to Following lasts until the app
  // is closed (sessionStorage), including pull to refresh and reloads.
  var MODE_KEY = 'following.mode';
  // The feed Home opens on is a setting ("Default feed"). Switching feeds sticks until the app is
  // closed; a new default takes over as soon as it's changed.
  // Which feeds Home has (Customize feeds; All is off unless switched on), and which it opens on.
  var FEEDS_ON = [['friends', 'feedFriends'], ['following', 'feedFollowing'], ['all', 'allFeed']].filter(function (f) {
    return f[0] === 'all' ? !!(window.__FL && window.__FL.allFeed === true) : S(f[1]);
  }).map(function (f) { return f[0]; });
  if (!FEEDS_ON.length) FEEDS_ON = ['friends'];
  var DEFAULT_FEED = window.__FL && FEEDS_ON.indexOf(window.__FL.defaultFeed) !== -1 ? window.__FL.defaultFeed : FEEDS_ON[0];
  try {
    if (sessionStorage.getItem('following.modeDefault') !== DEFAULT_FEED) {
      sessionStorage.setItem(MODE_KEY, DEFAULT_FEED);
      sessionStorage.setItem('following.modeDefault', DEFAULT_FEED);
    }
  } catch (e) {}
  function feedMode() {
    try {
      var m = sessionStorage.getItem(MODE_KEY);
      return FEEDS_ON.indexOf(m) !== -1 ? m : DEFAULT_FEED;
    } catch (e) { return DEFAULT_FEED; }
  }
  function setFeedMode(m) {
    var changed = m !== feedMode();
    try { sessionStorage.setItem(MODE_KEY, m); } catch (e) {}
    document.scrollingElement.scrollTop = 0;
    if (!changed) { queue(); return; }
    // Draw the other feed now. Caught up there: its check draws in with its own "success" tap.
    // Otherwise: a light tap, the same as the tab bar's buttons.
    tick();
    var caughtUp = [].some.call(document.querySelectorAll('#fl-ff .cu-ic'), function (svg) {
      var r = svg.getBoundingClientRect();
      return r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
    });
    if (!caughtUp) post({ type: 'haptic', value: 'tap' });   // the app checks the haptics setting
  }

  function addModeStyle() {
    if (document.getElementById('fl-modes-css')) return;
    var st = document.createElement('style');
    st.id = 'fl-modes-css';
    st.textContent = [
      '#fl-modes{display:flex;align-items:baseline;gap:18px;padding-left:4px}',
      '#fl-modes button{all:unset;cursor:pointer;font:700 24px/1.2 -apple-system,system-ui,sans-serif;color:#a8a8a8;-webkit-tap-highlight-color:transparent}',
      '#fl-modes button[aria-pressed="true"]{color:#000}',
      '@media (prefers-color-scheme: dark){#fl-modes button[aria-pressed="true"]{color:#f5f5f5}}',
      // Both Home feeds: Instagram's own list is hidden; the app's list (#fl-ff) shows instead.
      'html.fl-own main > :not(#fl-ff){display:none !important}',
      // Until the app has seen one "load more" request, Instagram's list stays laid out but
      // invisible, with its posts hidden, so its own loader runs once and the app can learn it.
      'html.fl-own-boot main{position:relative}',
      'html.fl-own-boot main > :not(#fl-ff){position:absolute !important;top:0;left:0;right:0;opacity:0 !important;pointer-events:none !important;z-index:-1}',
      'html.fl-own-boot main > :not(#fl-ff) article{display:none !important}',
      '#fl-ff{font:14px/18px -apple-system,system-ui,sans-serif;color:#000;background:#fff}',
      '#fl-ff a{color:inherit;text-decoration:none}',
      '#fl-ff .p{border-bottom:.5px solid #efefef;padding-bottom:12px}',
      '#fl-ff .h{display:flex;align-items:center;gap:10px;padding:10px 12px}',
      '#fl-ff .h img{flex:none;width:32px;height:32px;border-radius:50%;object-fit:cover;background:#efefef}',
      '#fl-ff .h .u{font-weight:600;flex:none}',
      '#fl-ff .h .w{min-width:0;flex:1;display:flex;flex-direction:column}',
      '#fl-ff .h .nl{display:flex;align-items:baseline;gap:6px;min-width:0}',
      '#fl-ff .h .bio{color:#737373;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
      '#fl-ff .h .loc{font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#fl-ff .m{position:relative;background:#000;overflow:hidden}',
      '#fl-ff .track{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;height:100%}',
      '#fl-ff .track::-webkit-scrollbar{display:none}',
      '#fl-ff .slide{flex:0 0 100%;scroll-snap-align:center;height:100%;display:flex;align-items:center;justify-content:center;background:#000}',
      '#fl-ff .slide img,#fl-ff .slide video{width:100%;height:100%;object-fit:cover;display:block}',
      '#fl-ff .slide{position:relative}',
      '#fl-ff .pip{all:unset;position:absolute;top:10px;left:10px;width:34px;height:34px;border-radius:17px;background:rgba(18,18,18,.6);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent}',
      '#fl-ff .pip svg{width:20px;height:20px}',
      '#fl-ff .spd{all:unset;position:absolute;top:10px;right:10px;min-width:44px;height:32px;padding:0 12px;box-sizing:border-box;border-radius:16px;background:rgba(18,18,18,.6);color:#fff;font:700 15px/32px -apple-system,system-ui,sans-serif;text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent}',
      '#fl-ff .spd.on{background:rgba(225,48,108,.9)}',
      '#fl-ff .dots{display:flex;justify-content:center;gap:4px;padding-top:8px}',
      '#fl-ff .a .cc{font-weight:600;font-size:14px}',
      '#fl-ff .a .more-b svg{stroke-linecap:round}',
      '#fl-menu{position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;justify-content:flex-end;background:rgba(0,0,0,0);transition:background .2s}',
      '#fl-menu.on{background:rgba(0,0,0,.4)}',
      '#fl-menu .sheet{background:var(--fl-sheet,#fff);border-radius:16px 16px 0 0;padding:8px 0 calc(24px + env(safe-area-inset-bottom));transform:translateY(100%);transition:transform .25s ease;font:400 16px/1.3 -apple-system,system-ui,sans-serif;color:var(--fl-strong)}',
      '#fl-menu.on .sheet{transform:none}',
      '#fl-menu .grab{width:36px;height:5px;border-radius:3px;background:#c7c7c7;margin:0 auto 10px}',
      '#fl-menu .who{text-align:center;font-weight:600;font-size:14px;color:var(--fl-muted);padding:2px 16px 10px}',
      '#fl-menu button{all:unset;display:block;width:100%;box-sizing:border-box;padding:15px 20px;cursor:pointer;-webkit-tap-highlight-color:transparent}',
      '#fl-menu button:active{background:rgba(127,127,127,.15)}',
      '#fl-menu button.red{color:#ed4956;font-weight:600}',
      '#fl-menu .msg{padding:15px 20px;color:var(--fl-muted);font-size:14px}',
      '@media (prefers-color-scheme: dark){#fl-menu .sheet{--fl-sheet:#262626}}',
      '#fl-ff .n{position:absolute;top:12px;right:12px;padding:3px 9px;border-radius:12px;background:rgba(18,18,18,.7);color:#fff;font:600 12px/18px -apple-system,system-ui,sans-serif;pointer-events:none;transition:opacity .3s}',
      '#fl-ff .n.off{opacity:0}',
      '#fl-ff .pop{position:absolute;left:50%;top:50%;width:96px;height:96px;margin:-48px 0 0 -48px;color:#fff;pointer-events:none;filter:drop-shadow(0 2px 8px rgba(0,0,0,.35));animation:flpop .9s ease-out forwards}',
      '#fl-ff .pop svg{width:100%;height:100%}',
      '@keyframes flpop{0%{transform:scale(0);opacity:0}15%{transform:scale(1.2);opacity:1}30%{transform:scale(.95)}45%{transform:scale(1)}80%{opacity:1}100%{transform:scale(1);opacity:0}}',
      '#fl-ff .dots i{width:6px;height:6px;border-radius:50%;background:#dbdbdb}',
      '#fl-ff .dots i.on{background:#0095f6}',
      '#fl-ff .a{display:flex;align-items:center;gap:14px;padding:8px 12px 4px}',
      '#fl-ff .a button,#fl-ff .a a{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;font-weight:600;-webkit-tap-highlight-color:transparent}',
      '#fl-ff .a svg{width:24px;height:24px}',
      '#fl-ff .a .sv{margin-left:auto}',
      '#fl-ff .like.on svg{fill:#ff3040;stroke:#ff3040}',
      '#fl-ff .t{padding:2px 12px}',
      '#fl-ff .t b{font-weight:600}',
      '#fl-ff .cap{padding:2px 12px;white-space:pre-wrap;word-wrap:break-word}',
      '#fl-ff .cap.clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '#fl-ff .more,#fl-ff .vc,#fl-ff .ago{color:#737373}',
      '#fl-ff .vc{display:block;padding:4px 12px 0}',
      '#fl-ff .ago{display:block;padding:4px 12px 0;font-size:12px}',
      '#fl-ff .ago.old{color:#ed4956;font-weight:700}',
      '#fl-ff .cu{padding:28px 24px;text-align:center;border-bottom:.5px solid #efefef}',
      '#fl-ff .cu-t{font:700 20px/1.25 -apple-system,system-ui,sans-serif;margin-bottom:6px;color:#1f9d55}',
      '#fl-ff .cu-ic{display:block;width:56px;height:56px;margin:0 auto 10px}',
      '#fl-ff .cu-st{margin-top:14px;font-size:16px;font-weight:600;color:var(--fl-strong)}',
      '#fl-ff .cu-st:empty{display:none}',
      '#fl-ff .cu-s button{all:unset;cursor:pointer;display:block;margin:10px auto 0;color:#0095f6;font-weight:600}',
      '#fl-ff .cu-s{color:#737373;font-size:14px;line-height:1.4}',
      '#fl-ff .cu-s b,#fl-ff .end b{font-weight:700}',
      '#fl-ff .end{padding:28px 24px 40px;text-align:center;color:#737373;font-size:15px;line-height:1.4}',
      '#fl-ff .end button{all:unset;cursor:pointer;color:#0095f6;font-weight:600}',
      '@media (prefers-color-scheme: dark){#fl-ff{background:#000;color:#f5f5f5}#fl-ff .p{border-color:#262626}#fl-ff .dots i{background:#363636}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  function modeSwitchStep() {
    if (TAB !== 'home' || !onFollowingFeed()) return;
    var header = document.querySelector('header');
    var h1 = header && header.querySelector('h1');
    if (!h1) return;
    addModeStyle();
    var bar = document.getElementById('fl-modes');
    if (!bar || !header.contains(bar)) {
      if (bar) bar.remove();
      bar = document.createElement('div');
      bar.id = 'fl-modes';
      [['friends', 'Friends'], ['following', 'Following'], ['all', 'All']].filter(function (p) { return FEEDS_ON.indexOf(p[0]) !== -1; }).forEach(function (pair) {
        var b = document.createElement('button');
        b.type = 'button';
        b.dataset.mode = pair[0];
        b.textContent = pair[1];
        b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); setFeedMode(pair[0]); });
        bar.appendChild(b);
      });
      h1.parentElement.insertBefore(bar, h1);
    }
    h1.style.setProperty('display', 'none', 'important');
    var mode = feedMode();
    var buttons = bar.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].dataset.mode === mode ? 'true' : 'false');
    }
  }

  // Open an Instagram address full screen over the feed (the app's stories layer).
  function openOver(path) {
    post({ type: 'openOverlay', value: location.origin + path });
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(d, filled) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', filled ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linejoin', 'round');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }
  var HEART = 'M16.8 3.5c-2 0-3.6 1.1-4.8 2.8-1.2-1.7-2.8-2.8-4.8-2.8C4.3 3.5 2 5.9 2 8.9c0 5.6 8.6 11 10 11.6 1.4-.6 10-6 10-11.6 0-3-2.3-5.4-5.2-5.4z';
  var BUBBLE = 'M20.7 16.4A9.5 9.5 0 1 0 17 20.1L21.5 21.5z';
  var PLANE = 'M21.5 2.5 2.5 9.8l7.3 3.2 3.2 7.5zM9.8 13 21.5 2.5';
  // Three lines, like the app's icon (two long, one short), for the post menu.
  var LINES = 'M4.5 7h15M4.5 12h15M4.5 17h9.5';
  var BOOKMARK = 'M19 21 12 16 5 21V3.5h14z';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function count(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function ago(sec) {
    var d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' minutes ago';
    if (d < 86400) { var h = Math.round(d / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    var days = Math.round(d / 86400);
    if (days < 7) return days + (days === 1 ? ' day ago' : ' days ago');
    return new Date(sec * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }
  function bestImage(m) {
    var c = (m.image_versions2 && m.image_versions2.candidates) || [];
    var pick = null;
    for (var i = 0; i < c.length; i++) if (c[i].width >= 720 && (!pick || c[i].width < pick.width)) pick = c[i];
    return (pick || c[0] || {}).url || m.display_uri || '';
  }
  // Picture in Picture: the video keeps playing in a small window over other tabs and apps,
  // with iOS's own controls (pause, skip back and forward).
  function pipButton(v) {
    var b = el('button', 'pip');
    b.type = 'button';
    b.setAttribute('aria-label', 'Picture in Picture');
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var outer = document.createElementNS(SVG_NS, 'rect');
    outer.setAttribute('x', '2.5'); outer.setAttribute('y', '4.5'); outer.setAttribute('width', '19'); outer.setAttribute('height', '15');
    outer.setAttribute('rx', '2'); outer.setAttribute('fill', 'none'); outer.setAttribute('stroke', 'currentColor'); outer.setAttribute('stroke-width', '2');
    var inner = document.createElementNS(SVG_NS, 'rect');
    inner.setAttribute('x', '11.5'); inner.setAttribute('y', '11'); inner.setAttribute('width', '7.5'); inner.setAttribute('height', '5.5');
    inner.setAttribute('rx', '1'); inner.setAttribute('fill', 'currentColor');
    svg.appendChild(outer);
    svg.appendChild(inner);
    b.appendChild(svg);
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var p = v.play();
      if (p && p.catch) p.catch(function () {});
      if (v.webkitSupportsPresentationMode && v.webkitSupportsPresentationMode('picture-in-picture')) {
        v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
      } else if (document.pictureInPictureEnabled && v.requestPictureInPicture) {
        (document.pictureInPictureElement === v ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(function () {});
      }
    });
    return b;
  }

  // Change a video's speed without losing its place: Safari can jump a playing video back
  // about a second when its speed changes, so put it back where it was if that happens.
  function setRateKeepingSpot(v, rate) {
    if (v.playbackRate === rate) return;
    var at = v.currentTime;
    v.playbackRate = rate;
    var fix = function () {
      // (Not when it simply looped back to the start at its end.)
      if (v.currentTime < at - 0.15 && !v.seeking && !(v.duration - at < 0.6)) v.currentTime = at;
    };
    setTimeout(fix, 60);
    setTimeout(fix, 250);
  }

  // 2× for one video in the feed: each video has its own and starts at 1×; tapping switches
  // between 1× and 2× (pink while 2×), and the speed stays with that video only.
  function speedButtonFor(v) {
    var b = el('button', 'spd', '1×');
    b.type = 'button';
    b.setAttribute('aria-label', 'Playback speed');
    var show = function () {
      var two = v.playbackRate > 1.5;
      b.textContent = two ? '2×' : '1×';
      b.classList.toggle('on', two);
    };
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var rate = v.playbackRate > 1.5 ? 1 : 2;
      setRateKeepingSpot(v, rate);
      v.defaultPlaybackRate = rate;
      if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      show();
    });
    v.addEventListener('ratechange', show);
    // Safari can put the speed back to normal when a video starts again: keep this one's.
    v.addEventListener('playing', function () {
      if (v.playbackRate !== v.defaultPlaybackRate) v.playbackRate = v.defaultPlaybackRate;
      show();
    });
    return b;
  }

  function slideFor(m) {
    var s = el('div', 'slide');
    var video = m.video_versions && m.video_versions[0] && m.video_versions[0].url;
    if (video) {
      var v = document.createElement('video');
      v.src = video;
      v.poster = bestImage(m);
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.controls = true;
      v.preload = 'metadata';
      v.loop = true;
      s.appendChild(v);
      s.appendChild(pipButton(v));
      s.appendChild(speedButtonFor(v));
    } else {
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = m.accessibility_caption || '';
      img.src = bestImage(m);
      s.appendChild(img);
    }
    return s;
  }

  function cookie(name) {
    var m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Like or unlike with the same request Instagram's own heart sends (a GraphQL mutation).
  // Its id and headers are learned from Instagram's own like button (privacy-hook.js, part 4);
  // the values below were current in November 2026 and are only used until then.
  var LIKE_DEFAULTS = {
    like: { name: 'usePolarisLikeMediaXIGLikeMutation', doc: '27182485238052618', url: '/api/graphql',
      headers: { 'x-ig-app-id': '1217981644879628', 'x-asbd-id': '359341' }, caller: 'RelayModern' },
    unlike: { name: 'usePolarisLikeMediaXIGUnlikeMutation', doc: '27345296031770102', url: '/api/graphql',
      headers: { 'x-ig-app-id': '1217981644879628', 'x-asbd-id': '359341' }, caller: 'RelayModern' }
  };
  var likeSeq = 100;

  function likeRequest(kind, m) {
    var tpl = LIKE_DEFAULTS[kind];
    try { tpl = JSON.parse(localStorage.getItem('following.likeTpl.' + kind) || 'null') || tpl; } catch (e) {}
    var session = freshSession();
    if (!session || !session.fb_dtsg) return Promise.reject(new Error('no session'));
    var params = new URLSearchParams();
    for (var k in session) params.set(k, session[k]);
    var actor = session.av || session.__user;
    var input = { actor_id: actor, client_mutation_id: String(likeSeq++), media_id: String(m.pk || String(m.id).split('_')[0]),
      tracking_token: m.organic_tracking_token || '' };
    if (kind === 'like') input.container_module = 'feed_timeline';
    params.set('fb_api_caller_class', tpl.caller || 'RelayModern');
    params.set('fb_api_req_friendly_name', tpl.name);
    params.set('variables', JSON.stringify({ input: input }));
    params.set('server_timestamps', 'true');
    params.set('doc_id', tpl.doc);
    var headers = {};
    for (var h in tpl.headers) headers[h] = tpl.headers[h];
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['x-fb-friendly-name'] = tpl.name;
    headers['x-csrftoken'] = cookie('csrftoken');
    if (session.lsd) headers['x-fb-lsd'] = session.lsd;
    return (window.__flFetch || fetch)(tpl.url, { method: 'POST', credentials: 'include', headers: headers, body: params.toString() })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, text: t }; }); })
      .then(function (res) {
        var j = null;
        try { j = JSON.parse(res.text.replace(/^for \(;;\);/, '').split('\n')[0]); } catch (e) {}
        if (!res.ok || !j || j.errors || !j.data) throw new Error(res.text.slice(0, 160));
        return j;
      });
  }

  // Debugging: lets a developer try the like request from the Mac (following/ev.sh).
  window.__flLikeRequest = likeRequest;

  // Any of Instagram's own GraphQL requests, sent the way its pages send them (used for the
  // offline stories: loading them, and later telling Instagram which ones you watched).
  function gqlRequest(name, doc, variables) {
    var session = freshSession();
    if (!session || !session.fb_dtsg) return Promise.reject(new Error('no session'));
    var params = new URLSearchParams();
    for (var k in session) params.set(k, session[k]);
    params.set('fb_api_caller_class', 'RelayModern');
    params.set('fb_api_req_friendly_name', name);
    params.set('variables', JSON.stringify(variables));
    params.set('server_timestamps', 'true');
    params.set('doc_id', doc);
    var headers = { 'content-type': 'application/x-www-form-urlencoded', 'x-fb-friendly-name': name,
      'x-csrftoken': cookie('csrftoken'), 'x-ig-app-id': '1217981644879628', 'x-asbd-id': '359341' };
    if (session.lsd) headers['x-fb-lsd'] = session.lsd;
    return (window.__flFetch || fetch)('/api/graphql', { method: 'POST', credentials: 'include', headers: headers, body: params.toString() })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, text: t }; }); })
      .then(function (res) {
        var j = null;
        try { j = JSON.parse(res.text.replace(/^for \(;;\);/, '').split('\n')[0]); } catch (e) {}
        if (!res.ok || !j || j.errors || !j.data) throw new Error(res.text.slice(0, 200));
        return j.data;
      });
  }
  window.__flGql = gqlRequest;

  // Bios (for the Friends feed). The feeds' posts don't carry them, so the app asks Instagram the
  // way its own profile page does (PolarisProfilePageContentQuery, learned by privacy-hook.js;
  // the built-in copy is the fallback), one account at a time, and keeps the answers on the phone
  // for a week in localStorage ("following.profiles", by user id).
  var PROFILE_KEY = 'following.profiles', PROFILE_DAYS = 7;
  var PROFILE_DEFAULT = { name: 'PolarisProfilePageContentQuery', doc: '40158838120366999', url: '/api/graphql', caller: 'RelayModern',
    headers: { 'x-ig-app-id': '1217981644879628', 'x-asbd-id': '359341' },
    vars: { enable_integrity_filters: true,
      __relay_internal__pv__PolarisCannesGuardianExperienceEnabledrelayprovider: true,
      __relay_internal__pv__PolarisCASB976ProfileEnabledrelayprovider: false,
      __relay_internal__pv__PolarisProfileInformTreatmentBannerEnabledrelayprovider: false,
      __relay_internal__pv__PolarisWebSchoolsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisProfileRingsGradientEnabledrelayprovider: true,
      __relay_internal__pv__PolarisRepostsConsumptionEnabledrelayprovider: true,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: true } };
  var profiles = {};
  try { profiles = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}') || {}; } catch (e) { profiles = {}; }
  (function () {
    var cutoff = Date.now() - PROFILE_DAYS * 86400000;
    for (var k in profiles) if (!profiles[k] || profiles[k].t < cutoff) delete profiles[k];
  })();
  var profileQueue = [], profileQueued = {}, profileBusy = 0, profilePauseUntil = 0, profileFails = 0;
  function saveProfiles() { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profiles)); } catch (e) {} }
  function userId(u) { return String(u.pk || u.id || ''); }
  function profileOf(u) { return profiles[userId(u)] || null; }

  function profileRequest(id) {
    var tpl = PROFILE_DEFAULT;
    try { tpl = JSON.parse(localStorage.getItem('following.profileTpl') || 'null') || tpl; } catch (e) {}
    var session = freshSession();
    if (!session || !session.fb_dtsg) return Promise.reject(new Error('no session'));
    var params = new URLSearchParams();
    for (var k in session) params.set(k, session[k]);
    var vars = {};
    for (var v in tpl.vars) vars[v] = tpl.vars[v];
    vars.id = id;
    params.set('fb_api_caller_class', tpl.caller || 'RelayModern');
    params.set('fb_api_req_friendly_name', tpl.name);
    params.set('variables', JSON.stringify(vars));
    params.set('server_timestamps', 'true');
    params.set('doc_id', tpl.doc);
    var headers = {};
    for (var h in tpl.headers) headers[h] = tpl.headers[h];
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['x-fb-friendly-name'] = tpl.name;
    headers['x-csrftoken'] = cookie('csrftoken');
    if (session.lsd) headers['x-fb-lsd'] = session.lsd;
    return (window.__flFetch || fetch)(tpl.url, { method: 'POST', credentials: 'include', headers: headers, body: params.toString() })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t }; }); })
      .then(function (res) {
        var j = null;
        try { j = JSON.parse(res.text.replace(/^for \(;;\);/, '').split('\n')[0]); } catch (e) {}
        var u = j && j.data && j.data.user;
        if (!res.ok || !u || typeof u.follower_count !== 'number') { var err = new Error('profile ' + res.status); err.status = res.status; throw err; }
        return { f: u.follower_count, b: typeof u.biography === 'string' ? u.biography : '', t: Date.now() };
      });
  }
  window.__flProfileRequest = profileRequest;

  function wantProfile(u) {
    var id = userId(u);
    if (!id || profiles[id] || profileQueued[id]) return;
    profileQueued[id] = 1;
    profileQueue.push(id);
    pumpProfiles();
  }
  function pumpProfiles() {
    if (profileBusy >= 3 || !profileQueue.length) return;
    var wait = profilePauseUntil - Date.now();
    if (wait > 0) { setTimeout(pumpProfiles, wait + 50); return; }
    var id = profileQueue.shift();
    profileBusy++;
    profileRequest(id).then(function (p) {
      profiles[id] = p;
      profileFails = 0;
      saveProfiles();
      fillBios(id);
    }, function (err) {
      profileFails++;
      // Too many requests, or not signed in yet: wait and try again (a minute after a 429).
      profilePauseUntil = Date.now() + (err && err.status === 429 ? 60000 : Math.min(30000, 1000 * profileFails));
      delete profileQueued[id];
      profileQueue.push(id);
      profileQueued[id] = 1;
    }).then(function () {
      profileBusy--;
      setTimeout(pumpProfiles, 100);
    });
  }
  window.__flProfileState = function () { return { queued: profileQueue.length, busy: profileBusy, fails: profileFails, pause: Math.max(0, profilePauseUntil - Date.now()), known: Object.keys(profiles).length }; };

  // A friend: a private account.
  function isFriend(m) { return isPrivate(m); }

  // Fill in the bio on cards already drawn once an account's profile arrives.
  function fillBios(id) {
    var heads = document.querySelectorAll('#fl-ff .nl[data-uid="' + id + '"]');
    for (var i = 0; i < heads.length; i++) {
      var line = heads[i];
      if (line.querySelector('.bio')) continue;
      var b = bioLine(line.__flUser || {});
      if (b) line.appendChild(el('span', 'bio', b));
    }
  }

  // A bio to show next to the name, in both Home feeds: for private accounts, and public ones
  // with under 4,000 followers (not big public pages). No links, emails or line breaks; none if
  // it's only emoji.
  // The limit is a setting.
  var BIO_MAX_FOLLOWERS = (window.__FL && typeof window.__FL.bioLimit === 'number') ? window.__FL.bioLimit : 4000;
  // Bios you've hidden from the post menu ("Hide bio for this user"), by account id, on the phone.
  var HIDDEN_BIOS_KEY = 'following.hiddenBios';
  var hiddenBios = {};
  try { hiddenBios = JSON.parse(localStorage.getItem(HIDDEN_BIOS_KEY) || '{}') || {}; } catch (e) { hiddenBios = {}; }
  // Bios shown by hand (Show bio for this user), even over the follower limit.
  var SHOWN_BIOS_KEY = 'following.shownBios';
  var shownBios = {};
  try { shownBios = JSON.parse(localStorage.getItem(SHOWN_BIOS_KEY) || '{}') || {}; } catch (e) { shownBios = {}; }
  function setBioHidden(u, hide) {
    var id = userId(u);
    if (!id) return;
    if (hide) { hiddenBios[id] = 1; delete shownBios[id]; } else { delete hiddenBios[id]; shownBios[id] = 1; }
    try { localStorage.setItem(HIDDEN_BIOS_KEY, JSON.stringify(hiddenBios)); } catch (e) {}
    try { localStorage.setItem(SHOWN_BIOS_KEY, JSON.stringify(shownBios)); } catch (e) {}
    // Every card from this account, right away.
    [].forEach.call(document.querySelectorAll('#fl-ff article'), function (a) {
      if (a.__flUser && userId(a.__flUser) === id) {
        var line = a.querySelector('.nl');
        var old = line && line.querySelector('.bio');
        if (old) old.remove();
        var b = !hide && bioLine(a.__flUser);
        if (line && b) line.appendChild(el('span', 'bio', b));
      }
    });
  }
  // force: the bio as it would show if switched on for this account (for the post menu).
  function bioLine(u, force) {
    var forced = force || !!shownBios[userId(u)];
    if (!force && hiddenBios[userId(u)]) return '';
    if (!S('bios') && !forced) return '';
    var p = profileOf(u);
    if (!p || !p.b) return '';
    var priv = typeof u.is_private === 'boolean' ? u.is_private :
      (window.__flPrivacy || {})[(u.username || '').toLowerCase()] === true;
    // Public accounts: only under the follower limit, and only if that's switched on.
    if (!priv && !forced && (!S('bioPublic') || !(p.f < BIO_MAX_FOLLOWERS))) return '';
    var b = p.b
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
      .replace(/\S+@\S+\.\S+/g, '')
      .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|me|app|ly|gg|tv|us|edu|link|bio|page|shop|store)(?:\/\S*)?/gi, '')
      .replace(/\s+/g, ' ')
      .replace(/^[\s|•·,;:-]+|[\s|•·,;:-]+$/g, '');
    // Nothing but emoji: no bio. (@mentions count as words.)
    try { if (!/[\p{L}\p{N}]/u.test(b)) return ''; } catch (e) { if (!/[A-Za-z0-9]/.test(b)) return ''; }
    return b;
  }

  // Likes made without signal (posts already on screen): kept on the phone and sent when the
  // connection is back, from the Home page. Liking then unliking before that cancels out.
  var LIKE_Q_KEY = 'following.likeQueue';
  function likeQueue() { try { return JSON.parse(localStorage.getItem(LIKE_Q_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveLikeQueue(q) { try { localStorage.setItem(LIKE_Q_KEY, JSON.stringify(q)); } catch (e) {} }
  function noSignal(err) {
    return !navigator.onLine || err instanceof TypeError || /no session|Load failed|network/i.test(String(err && err.message || err));
  }
  function likeLater(m, want, err) {
    if (!noSignal(err)) return false;
    var q = likeQueue(), pk = String(m.pk || String(m.id).split('_')[0]);
    var e = q[pk];
    if (e && e.orig === want) delete q[pk];   // back to how it was: nothing to send
    else q[pk] = { want: want, orig: e ? e.orig : !want, id: String(m.id || pk), token: m.organic_tracking_token || '' };
    saveLikeQueue(q);
    return true;
  }
  // A post drawn again before its like went out still shows it.
  function applyQueuedLike(m) {
    var e = likeQueue()[String(m.pk || String(m.id || '').split('_')[0])];
    if (e) m.has_liked = e.want;
  }
  var flushingLikes = false;
  function flushLikes() {
    if (TAB !== 'home' || flushingLikes || !navigator.onLine) return;
    var q = likeQueue(), pks = Object.keys(q);
    if (!pks.length) return;
    flushingLikes = true;
    var next = function (i) {
      if (i >= pks.length) { flushingLikes = false; return; }
      var pk = pks[i], e = q[pk];
      likeRequest(e.want ? 'like' : 'unlike', { pk: pk, id: e.id, organic_tracking_token: e.token }).then(function () {
        var now = likeQueue(); delete now[pk]; saveLikeQueue(now);
        next(i + 1);
      }, function (err) {
        if (noSignal(err)) { flushingLikes = false; return; }   // still no signal: later
        var now = likeQueue(); delete now[pk]; saveLikeQueue(now);   // Instagram said no: drop it
        next(i + 1);
      });
    };
    next(0);
  }
  window.addEventListener('online', function () { setTimeout(flushLikes, 1500); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(flushLikes, 1500); });
  setInterval(flushLikes, 30000);
  setTimeout(flushLikes, 6000);
  window.__flLikeQueue = likeQueue;
  // Debugging from the Mac (following/ev.sh), with made-up posts only.
  window.__flLikeLater = likeLater;
  window.__flApplyQueuedLike = applyQueuedLike;

  function toggleLike(m, btn, label) {
    var want = !m.has_liked;
    var setUi = function (liked) {
      m.has_liked = liked;
      btn.classList.toggle('on', liked);
      btn.replaceChild(icon(HEART, liked), btn.firstChild);
      btn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
    };
    setUi(want);
    if (want) post({ type: 'haptic', value: 'like' });   // the app checks "Haptic on likes"
    if (typeof m.like_count === 'number') { m.like_count += want ? 1 : -1; label(); }
    likeRequest(want ? 'like' : 'unlike', m).catch(function (err) {
      try { window.__flLikeError = String(err && err.message || err); } catch (e) {}
      // No signal: keep it liked, and send it once the connection is back.
      if (likeLater(m, want, err)) return;
      setUi(!want);
      if (typeof m.like_count === 'number') { m.like_count += want ? -1 : 1; label(); }
    });
  }

  function card(m) {
    applyQueuedLike(m);
    var user = m.user || {};
    var name = user.username || '';
    var p = el('article', 'p');
    p.dataset.code = m.code;

    var h = el('div', 'h');
    var av = document.createElement('img');
    av.src = user.profile_pic_url || '';
    av.alt = '';
    var un = el('a', 'u', name);
    un.href = '/' + name + '/';
    [av, un].forEach(function (x) {
      x.addEventListener('click', function (e) { e.preventDefault(); openOver('/' + name + '/'); });
    });
    h.appendChild(av);
    // Name (with the bio after it, on one line), and the post's location under it.
    var who = el('div', 'w');
    var line = el('div', 'nl');
    line.appendChild(un);
    var bio = bioLine(user);
    if (bio) line.appendChild(el('span', 'bio', bio));
    else if (!profileOf(user)) {
      // Not looked up yet: the bio is added when it arrives.
      line.dataset.uid = userId(user);
      line.__flUser = user;
      wantProfile(user);
    }
    who.appendChild(line);
    var loc = S('locations') ? m.location : null;
    if (loc && loc.name) {
      var la = el('a', 'loc', loc.name);
      var lpath = loc.pk ? '/explore/locations/' + loc.pk + '/' : '';
      if (lpath) {
        la.href = lpath;
        la.addEventListener('click', function (e) { e.preventDefault(); openOver(lpath); });
      }
      who.appendChild(la);
    }
    h.appendChild(who);
    p.appendChild(h);

    var items = (m.carousel_media && m.carousel_media.length) ? m.carousel_media : [m];
    var w = m.original_width || (items[0] && items[0].original_width) || 1080;
    var ht = m.original_height || (items[0] && items[0].original_height) || 1080;
    var ratio = Math.min(Math.max(w / ht, 0.8), 1.91);
    var media = el('div', 'm');
    media.style.aspectRatio = String(ratio);
    var track = el('div', 'track');
    items.forEach(function (it) { track.appendChild(slideFor(it)); });
    media.appendChild(track);
    p.appendChild(media);
    if (items.length > 1) {
      var dots = el('div', 'dots');
      items.forEach(function (_, i) { var d = el('i', i === 0 ? 'on' : ''); dots.appendChild(d); });
      // "1/7" in the corner, as in the app: shown at first and while you swipe, then it fades.
      var n = el('div', 'n', '1/' + items.length);
      media.appendChild(n);
      var fade = null;
      var showCount = function () {
        n.classList.remove('off');
        clearTimeout(fade);
        fade = setTimeout(function () { n.classList.add('off'); }, 3000);
      };
      showCount();
      track.addEventListener('scroll', function () {
        var i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        [].forEach.call(dots.children, function (d, j) { d.classList.toggle('on', j === i); });
        n.textContent = (i + 1) + '/' + items.length;
        showCount();
      }, { passive: true });
      p.appendChild(dots);
    }

    var a = el('div', 'a');
    var like = el('button', 'like' + (m.has_liked ? ' on' : ''));
    like.type = 'button';
    like.setAttribute('aria-label', m.has_liked ? 'Unlike' : 'Like');
    like.appendChild(icon(HEART, !!m.has_liked));
    var cm = el('a', 'cm');
    cm.href = '/p/' + m.code + '/';
    cm.setAttribute('aria-label', 'Comments');
    cm.appendChild(icon(BUBBLE, false));
    // The number of comments next to the bubble, as in Instagram's app.
    if (S('commentCounts') && m.comment_count > 0 && !m.comments_disabled) cm.appendChild(el('span', 'cc', count(m.comment_count)));
    // Straight to the comments (Instagram's /comments/ page), not the post.
    cm.addEventListener('click', function (e) { e.preventDefault(); openOver('/p/' + m.code + '/comments/'); });
    // Share: Instagram's own "Send to" dialog. It opens the post full screen and taps
    // Instagram's Share button there (shareStep). Instagram's site has no Share on private
    // accounts' posts, so those get the iPhone's share sheet with the link instead.
    var sh = el('button', 'sh');
    sh.type = 'button';
    sh.setAttribute('aria-label', 'Share');
    sh.appendChild(icon(PLANE, false));
    sh.addEventListener('click', function (e) {
      e.preventDefault();
      if (!isPrivate(m)) { openOver('/p/' + m.code + '/?fl_share=1'); return; }
      var link = 'https://www.instagram.com/p/' + m.code + '/';
      if (navigator.share) navigator.share({ url: link }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(link);
    });
    // Save: the feed doesn't say whether you've saved a post, so the bookmark starts empty. It
    // opens the post, taps Instagram's own Save (or "Remove" when filled), and comes back
    // (saveStep).
    var sv = el('button', 'sv');
    sv.type = 'button';
    var setSaved = function (on) {
      sv.dataset.on = on ? '1' : '';
      sv.setAttribute('aria-label', on ? 'Remove from saved' : 'Save');
      sv.textContent = '';
      sv.appendChild(icon(BOOKMARK, on));
    };
    setSaved(m.has_viewer_saved === true);
    sv.addEventListener('click', function (e) {
      e.preventDefault();
      var on = !sv.dataset.on;
      setSaved(on);
      openOver('/p/' + m.code + '/?fl_save=' + (on ? '1' : '0'));
    });
    a.appendChild(like);
    a.appendChild(cm);
    a.appendChild(sh);
    // Public accounts: a "..." menu (hide their bio, mute their posts, unfollow).
    p.__flUser = user;
    if (!isPrivate(m)) {
      var more = el('button', 'more-b');
      more.type = 'button';
      more.setAttribute('aria-label', 'More options');
      more.appendChild(icon(LINES, false));
      more.addEventListener('click', function (e) { e.preventDefault(); openPostMenu(m, p); });
      a.appendChild(more);
    }
    a.appendChild(sv);
    p.appendChild(a);

    var t = el('div', 't');
    var renderLikes = function () {
      t.textContent = '';
      var top = (m.top_likers && m.top_likers[0]) || (m.facepile_top_likers && m.facepile_top_likers[0] && m.facepile_top_likers[0].username);
      // The poster hid the count: Instagram doesn't send the real one (like_count is a stand-in,
      // always about 3), so say it the way Instagram does.
      if (m.like_and_view_counts_disabled) {
        if (top) {
          t.appendChild(document.createTextNode('Liked by '));
          t.appendChild(el('b', '', String(top)));
          t.appendChild(document.createTextNode(' and '));
          t.appendChild(el('b', '', 'others'));
        } else if (m.has_liked) {
          t.appendChild(document.createTextNode('Liked by '));
          t.appendChild(el('b', '', 'you'));
        }
        return;
      }
      if (typeof m.like_count !== 'number') return;
      if (top && m.like_count > 1) {
        t.appendChild(document.createTextNode('Liked by '));
        t.appendChild(el('b', '', String(top)));
        t.appendChild(document.createTextNode(' and '));
        t.appendChild(el('b', '', count(m.like_count - 1) + (m.like_count - 1 === 1 ? ' other' : ' others')));
      } else {
        t.appendChild(el('b', '', count(m.like_count) + (m.like_count === 1 ? ' like' : ' likes')));
      }
    };
    renderLikes();
    like.addEventListener('click', function () { toggleLike(m, like, renderLikes); });

    // Double-tap the photo to like, as in the app: it only ever likes (never unlikes), with the
    // big heart.
    var lastTap = 0, lastX = 0, lastY = 0;
    media.addEventListener('click', function (e) {
      var now = Date.now();
      var close = Math.abs(e.clientX - lastX) < 40 && Math.abs(e.clientY - lastY) < 40;
      if (now - lastTap < 320 && close) {
        lastTap = 0;
        e.preventDefault();
        var pop = el('div', 'pop');
        pop.appendChild(icon(HEART, true));
        media.appendChild(pop);
        setTimeout(function () { pop.remove(); }, 950);
        if (!m.has_liked) toggleLike(m, like, renderLikes);
        return;
      }
      lastTap = now; lastX = e.clientX; lastY = e.clientY;
    });
    p.appendChild(t);

    var text = m.caption && m.caption.text;
    if (text) {
      var cap = el('div', 'cap clamp');
      cap.appendChild(el('b', '', name));
      cap.appendChild(document.createTextNode(' ' + text));
      p.appendChild(cap);
      if (text.length > 90 || text.indexOf('\n') !== -1) {
        var more = el('a', 'more', 'more');
        more.href = '#';
        more.style.padding = '0 12px';
        more.addEventListener('click', function (e) { e.preventDefault(); cap.classList.remove('clamp'); more.remove(); });
        p.appendChild(more);
      }
    }
    if (m.comment_count > 0 && !m.comments_disabled) {
      var vc = el('a', 'vc', m.comment_count === 1 ? 'View 1 comment' : 'View all ' + count(m.comment_count) + ' comments');
      vc.href = '/p/' + m.code + '/';
      vc.addEventListener('click', function (e) { e.preventDefault(); openOver('/p/' + m.code + '/comments/'); });
      p.appendChild(vc);
    }
    // 3 days old or more ("3 days ago", or a date): bold red, so older posts stand out.
    if (m.taken_at) p.appendChild(el('span', 'ago' + (S('oldDates') && Math.round((Date.now() / 1000 - m.taken_at) / 86400) >= OLD_DAYS ? ' old' : ''), ago(m.taken_at)));
    return p;
  }

  // Both Home feeds are drawn by the app from Instagram's feed data:
  //   Friends:   newest first (Instagram's Following feed), keeping only private accounts.
  //   Following: Instagram's suggested order (its ranked feed, as in the app's main feed), keeping
  //              only accounts you follow (no "Suggested for you" posts, no ads).
  // Ads stay out of every feed.
  function isAd(m) { return !!(m.ad_id || m.ad_action || m.ad_header_style || m.ad_metadata || m.is_ad); }

  var FEEDS = {
    // Instagram's regular feed, suggested posts included (no ads).
    all: {
      source: 'home',
      keep: function (m) { return !isAd(m); },
      looking: 'Loading your feed…',
      none: 'No recent posts.'
    },
    following: {
      source: 'home',
      keep: function (m) { var fs = (m.user || {}).friendship_status; return !!(fs && fs.following === true); },
      looking: 'Loading your feed…',
      none: 'No recent posts from accounts you follow.'
    },
    friends: {
      source: 'following',
      keep: function (m) { return isFriend(m); },
      looking: 'Looking for recent posts from private accounts you follow…',
      none: 'No recent posts from private accounts you follow.'
    }
  };

  // The app's own list: what it has drawn, and where the next page starts.
  function freshState(mode) {
    return { mode: mode, shown: {}, cards: 0, next: '', more: true, started: false, loading: false, error: false, emptyRun: 0,
      counted: {}, seenRun: 0, caughtUp: false, showSeen: false, held: 0,
      // Friends, once caught up: earlier posts you've seen but not liked, from the ranked feed.
      unliked: false, r: { next: '', more: true, started: false },
      // Following, once caught up: the posts you've seen but not liked, under the same divider.
      earlier: false, collapsed: false };
  }

  // Posts you have looked at (on screen for about a second), so a reload shows what's new.
  // Kept in localStorage for 14 days. Instagram's own app reports this to Instagram; the app
  // keeps it on the phone instead and skips those posts itself.
  var SEEN_KEY = 'following.seen', SEEN_DAYS = 14;
  var seen = {};
  try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (e) { seen = {}; }
  (function prune() {
    var cutoff = Date.now() - SEEN_DAYS * 86400000, n = 0;
    for (var k in seen) { if (seen[k] < cutoff) delete seen[k]; else n++; }
  })();
  var seenDirty = false;
  function saveSeen() {
    if (!seenDirty) return;
    seenDirty = false;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) {}
  }
  setInterval(saveSeen, 2000);
  addEventListener('pagehide', saveSeen);

  // Seen: on screen in this app, or marked seen by Instagram itself (is_seen, which includes what
  // you saw in Instagram's own app), or liked by you.
  function wasSeen(m) {
    return !!seen[m.code] || m.is_seen === true || !!m.has_liked;
  }

  var seenTimers = {};
  var seenObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      var code = en.target.dataset.code;
      if (!code) return;
      if (en.isIntersecting && en.intersectionRatio >= 0.5) {
        if (!seenTimers[code]) seenTimers[code] = setTimeout(function () {
          seen[code] = Date.now();
          seenDirty = true;
          seenObserver.unobserve(en.target);
        }, 1000);
      } else if (seenTimers[code]) {
        clearTimeout(seenTimers[code]);
        delete seenTimers[code];
      }
    });
  }, { threshold: [0, 0.5, 1] }) : null;
  var ff = freshState('following');
  var FF_ID = 'fl-ff';
  var bootNudges = 0, lastBootNudge = 0;

  function isPrivate(m) {
    var u = m.user || {};
    if (typeof u.is_private === 'boolean') return u.is_private;
    return (window.__flPrivacy || {})[(u.username || '').toLowerCase()] === true;
  }

  // Draw every kept post in the pages received so far, following the cursor chain from the first
  // page. Returns how many new posts were drawn.
  function drawPages(list) {
    var cfg = FEEDS[ff.mode];
    var pages = (window.__flFeed && window.__flFeed.pages && window.__flFeed.pages[cfg.source]) || {};
    var added = 0, guard = 0;
    var key = '';
    while (pages.hasOwnProperty(key) && guard++ < 500) {
      var pg = pages[key];
      var kept = 0, keptSeen = 0;
      for (var i = 0; i < pg.items.length; i++) {
        var m = pg.items[i];
        if (!cfg.keep(m)) continue;
        kept++;
        var already = wasSeen(m) && !ff.shown[m.code];
        if (already) keptSeen++;
        if (ff.shown[m.code]) continue;
        if (already && (!ff.showSeen || ff.collapsed)) { ff.held++; continue; }
        // Following's earlier posts: the ones you haven't liked (as in Friends).
        if (already && ff.earlier && m.has_liked && S('hideLikedEarlier')) continue;
        ff.shown[m.code] = 1;
        if (!window.__flFirstCard) window.__flFirstCard = Math.round(performance.now());
        var c = card(m);
        list.appendChild(c);
        if (seenObserver && !wasSeen(m)) seenObserver.observe(c);
        ff.cards++;
        added++;
      }
      // Caught up: two pages in a row whose posts (for this feed) were all seen before.
      if (!ff.counted[key]) {
        ff.counted[key] = 1;
        if (kept > 0 && keptSeen === kept) ff.seenRun++;
        else if (kept > keptSeen) ff.seenRun = 0;
        // Friends is newest first, so one page of seen posts means the rest are older and seen;
        // Following is ranked, so it waits for two.
        if (ff.seenRun >= (ff.mode === 'friends' ? 1 : 2) && !ff.showSeen && !ff.unliked) ff.caughtUp = true;
      }
      ff.next = pg.end;
      ff.more = pg.more && !!pg.end;
      ff.started = true;
      if (!pg.end || pg.end === key) break;
      key = pg.end;
    }
    return added;
  }

  // "Stories: 12/80 seen" under "You're all caught up" (the count comes from the story row,
  // through the app).
  window.__flSetStoryCount = function (text) {
    window.__flStoryCount = text;
    var els = document.querySelectorAll('#fl-ff .cu-st');
    for (var i = 0; i < els.length; i++) els[i].textContent = text;
  };
  function storyCountEl() {
    return el('div', 'cu-st', window.__flStoryCount || '');
  }

  // Instagram's own account actions (the same requests its site sends).
  function igAction(path, fields) {
    var body = new URLSearchParams(fields || {}).toString();
    return (window.__flFetch || fetch)(path, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-csrftoken': cookie('csrftoken'),
        'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest', 'x-instagram-ajax': '1' },
      body: body
    }).then(function (r) { return r.text().then(function (t) {
      var j = null; try { j = JSON.parse(t); } catch (e) {}
      if (!r.ok || !j || j.status !== 'ok') throw new Error(t.slice(0, 160));
      return j;
    }); });
  }
  window.__flIgAction = igAction;   // debugging (and the app's Muted accounts list)
  function igGet(path) {
    return (window.__flFetch || fetch)(path, { credentials: 'include',
      headers: { 'x-ig-app-id': '936619743392459', 'x-requested-with': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); });
  }
  // Tell the app (its Muted accounts list in App settings).
  function reportMuted(id, username, muted) { post({ type: 'muted', value: { id: id, username: username, muted: muted } }); }

  // Posts from accounts you've just muted or unfollowed leave the feed at once.
  function dropPostsFrom(u) {
    var id = userId(u);
    [].forEach.call(document.querySelectorAll('#fl-ff article'), function (a) {
      if (a.__flUser && userId(a.__flUser) === id) a.remove();
    });
  }

  // The "..." menu on a public account's post: an Instagram-style sheet from the bottom.
  function openPostMenu(m, cardEl) {
    var u = m.user || {}, id = userId(u), name = u.username || '';
    var old = document.getElementById('fl-menu');
    if (old) old.remove();
    var wrap = el('div');
    wrap.id = 'fl-menu';
    var sheet = el('div', 'sheet');
    sheet.appendChild(el('div', 'grab'));
    sheet.appendChild(el('div', 'who', '@' + name));
    var close = function () {
      wrap.classList.remove('on');
      setTimeout(function () { wrap.remove(); }, 250);
    };
    var row = function (label, cls, fn) {
      var b = el('button', cls || '', label);
      b.type = 'button';
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(b); });
      sheet.appendChild(b);
      return b;
    };
    var say = function (text) {
      sheet.textContent = '';
      sheet.appendChild(el('div', 'grab'));
      sheet.appendChild(el('div', 'msg', text));
      setTimeout(close, 1400);
    };
    // Says what it would do to what's on screen now: a bio left out by the follower limit (or
    // hidden by hand) can be shown, one showing can be hidden. No bio at all: no option.
    var showing = !!bioLine(u);
    if (showing || bioLine(u, true)) {
      row(showing ? 'Hide bio for this user' : 'Show bio for this user', '', function () {
        setBioHidden(u, showing);
        close();
      });
    }
    row('Mute posts', '', function (b) {
      b.textContent = 'Muting…';
      igAction('/api/v1/friendships/mute_posts_or_story_from_follow/', { target_posts_author_id: id }).then(function () {
        dropPostsFrom(u);
        reportMuted(id, name, true);
        say("Muted @" + name + "'s posts. Unmute in App settings or their profile's menu.");
      }, function () { say("Couldn't mute. Try again from their profile."); });
    });
    row('Unfollow', 'red', function (b) {
      // Asks once more before unfollowing.
      if (!b.__sure) { b.__sure = true; b.textContent = 'Tap again to unfollow @' + name; return; }
      b.textContent = 'Unfollowing…';
      igAction('/api/v1/friendships/destroy/' + id + '/', { user_id: id }).then(function () {
        dropPostsFrom(u);
        say('Unfollowed @' + name + '.');
      }, function () { say("Couldn't unfollow. Try again from their profile."); });
    });
    row('Cancel', '', close);
    wrap.appendChild(sheet);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    void wrap.offsetWidth;
    wrap.classList.add('on');
  }

  // The green check over "You're all caught up". Every time it comes into view (scrolling to it,
  // switching between Friends and Following, a refresh, coming back to Home) it is drawn in like
  // a payment going through: the ring draws around, then the tick, left to the bottom point to
  // the right, and a "success" tap you can feel lands as the tick finishes.
  var RING_MS = 380, TICK_MS = 300, MARK_DELAY = 80;
  function cuMark() {
    var d = document.createElement('div');
    d.innerHTML = '<svg class="cu-ic" viewBox="0 0 96 96" aria-hidden="true">' +
      '<circle class="rg" cx="48" cy="48" r="44" fill="none" stroke="#1f9d55" stroke-width="5" stroke-linecap="round" transform="rotate(-90 48 48)" style="stroke-dasharray:277;stroke-dashoffset:277"/>' +
      '<path class="ck" d="M29 50l12.5 12.5L67 35" fill="none" stroke="#1f9d55" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" style="stroke-dasharray:60;stroke-dashoffset:60"/></svg>';
    var svg = d.firstChild;
    if (checkObserver) checkObserver.observe(svg); else drawCheck(svg);
    return svg;
  }
  function strokeIn(el, ms, delay, ease) {
    var len = el.getTotalLength ? el.getTotalLength() : 100;
    el.style.transition = 'none';
    el.style.strokeDasharray = len;
    el.style.strokeDashoffset = len;
    void el.getBoundingClientRect();
    el.style.transition = 'stroke-dashoffset ' + ms + 'ms ' + ease + ' ' + delay + 'ms';
    el.style.strokeDashoffset = '0';
  }
  function drawCheck(svg) {
    var rg = svg.querySelector('.rg'), ck = svg.querySelector('.ck');
    if (!rg || !ck) return;
    if (!S('checkAnimation')) {
      // Shown whole at once (the success tap still lands, if that's on).
      [rg, ck].forEach(function (el) { el.style.transition = 'none'; el.style.strokeDashoffset = '0'; });
      if (S('hapticCheck')) post({ type: 'haptic', value: 'success' });
      return;
    }
    strokeIn(rg, RING_MS, MARK_DELAY, 'cubic-bezier(.45,0,.25,1)');
    strokeIn(ck, TICK_MS, MARK_DELAY + RING_MS - 40, 'cubic-bezier(.4,0,.2,1)');
    clearTimeout(svg.__t);
    svg.__t = setTimeout(function () { post({ type: 'haptic', value: 'success' }); }, MARK_DELAY + RING_MS - 40 + TICK_MS - 30);
  }
  function hideCheck(svg) {
    clearTimeout(svg.__t);
    [].forEach.call(svg.querySelectorAll('.rg,.ck'), function (el) {
      el.style.transition = 'none';
      el.style.strokeDashoffset = el.style.strokeDasharray || '300';
    });
  }
  var checkObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      var svg = en.target;
      if (en.isIntersecting && en.intersectionRatio >= 0.7) {
        if (!svg.__shown) { svg.__shown = true; drawCheck(svg); }
      } else if (!en.isIntersecting && svg.__shown) {
        // Fully out of view: drawn again next time.
        svg.__shown = false;
        hideCheck(svg);
      }
    });
  }, { threshold: [0, 0.7] }) : null;
  // Back on the Home tab (the app calls this): draw any check that's on screen again.
  window.__flReplayCheck = function () {
    [].forEach.call(document.querySelectorAll('#fl-ff .cu-ic'), function (svg) {
      var r = svg.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight && r.height > 0) { svg.__shown = true; hideCheck(svg); drawCheck(svg); }
    });
  };

  // Friends, after "You're all caught up": earlier posts from friends that you've seen
  // but not liked, in Instagram's suggested order (the ranked feed), under a divider.
  function startUnliked(list) {
    if (!window.__flFirstCard) window.__flFirstCard = Math.round(performance.now());
    ff.unliked = true;
    ff.caughtUp = false;
    ff.emptyRun = 0;
    caughtUpDivider(list, 'friends');
  }

  // Following, after "You're all caught up": the seen posts from the Following feed itself
  // (newest first), minus the ones you've liked.
  function startEarlier(list) {
    ff.earlier = true;
    ff.showSeen = true;
    ff.caughtUp = false;
    ff.seenRun = 0;
    ff.emptyRun = 0;
    ff.counted = {};
    caughtUpDivider(list, ff.mode);
  }

  // "You've seen all new posts from private accounts." (Friends) or "...from accounts you
  // follow." (Following), with the key word in bold.
  function seenLine(kind) {
    var span = document.createElement('span');
    var b = document.createElement('b');
    if (kind === 'friends') {
      span.appendChild(document.createTextNode("You've seen all new posts from "));
      b.textContent = 'private';
      span.appendChild(b);
      span.appendChild(document.createTextNode(' accounts.'));
    } else if (kind === 'all') {
      span.appendChild(document.createTextNode("You've seen all new posts in "));
      b.textContent = 'All';
      span.appendChild(b);
      span.appendChild(document.createTextNode('.'));
    } else {
      span.appendChild(document.createTextNode("You've seen all new posts from accounts you "));
      b.textContent = 'follow';
      span.appendChild(b);
      span.appendChild(document.createTextNode('.'));
    }
    return span;
  }

  function caughtUpDivider(list, kind) {
    var from = kind === 'friends' ? 'from your friends' : '';
    // At the top (nothing new above it, as after a refresh or reopening the app): keep the
    // earlier posts folded away until "View earlier posts".
    ff.collapsed = ff.cards === 0 && S('foldEarlier');
    var d = el('div', 'cu');
    d.appendChild(cuMark());
    d.appendChild(el('div', 'cu-t', "You're all caught up"));
    var notLiked = S('hideLikedEarlier') ? " you haven't liked yet" : '';
    var sub = el('div', 'cu-s');
    sub.appendChild(seenLine(kind));
    if (!ff.collapsed) sub.appendChild(document.createTextNode(' Here are earlier ones' + notLiked + '.'));
    if (ff.collapsed) {
      var open = el('button', '', 'View earlier posts');
      open.type = 'button';
      open.addEventListener('click', function () {
        ff.collapsed = false;
        sub.textContent = 'Here are earlier posts' + (from ? ' ' + from : '') + notLiked + '.';
        queue();
      });
      sub.appendChild(open);
    }
    d.appendChild(sub);
    d.appendChild(storyCountEl());
    list.appendChild(d);
  }

  function drawUnliked(list) {
    var pages = (window.__flFeed && window.__flFeed.pages && window.__flFeed.pages.home) || {};
    var added = 0, guard = 0, key = '';
    while (pages.hasOwnProperty(key) && guard++ < 500) {
      var pg = pages[key];
      for (var i = 0; i < pg.items.length; i++) {
        var m = pg.items[i];
        if (ff.shown[m.code] || (m.has_liked && S('hideLikedEarlier')) || !(seen[m.code] || m.is_seen === true)) continue;
        if (!isFriend(m)) continue;
        ff.shown[m.code] = 1;
        list.appendChild(card(m));
        ff.cards++;
        added++;
      }
      ff.r.next = pg.end;
      ff.r.more = pg.more && !!pg.end;
      ff.r.started = true;
      if (!pg.end || pg.end === key) break;
      key = pg.end;
    }
    return added;
  }

  // Session fields for repeating Instagram's requests: from Instagram's latest request on this
  // page if there is one, else from the page itself (Instagram has kept the token in different
  // places: "DTSGInitialData", and later "MRequestConfig" -> "dtsg"), with the account fields
  // (av, __user...) from the learned request.
  function freshSession() {
    var feed = window.__flFeed || {};
    if (feed.common && feed.common.fb_dtsg) return feed.common;
    var html = document.documentElement.innerHTML;
    var d = /"DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html) ||
      /"MRequestConfig",\[\],\{"dtsg":\{"token":"([^"]+)"/.exec(html) ||
      /"dtsg":\{"token":"([^"]+)"/.exec(html);
    var l = /"LSD",\[\],\{"token":"([^"]+)"/.exec(html);
    if (!d) return null;
    var out = {};
    if (feed.template) {
      var tp = new URLSearchParams(feed.template.body);
      ['av', '__user', '__a', '__d', '__comet_req', 'dpr', '__hs', '__rev', '__s', '__hsi', '__dyn', '__csr', '__spin_r', '__spin_b', '__spin_t', '__crn']
        .forEach(function (f) { if (tp.has(f)) out[f] = tp.get(f); });
    }
    var sum = 0;
    for (var i = 0; i < d[1].length; i++) sum += d[1].charCodeAt(i);
    out.fb_dtsg = d[1];
    out.lsd = l ? l[1] : '';
    out.jazoest = '2' + sum;
    return out;
  }

  // Ask Instagram for the page after `cursor` ('' for the first page) of the ranked feed
  // (source 'home') or the Following feed (source 'following'), with the request Instagram's own
  // site makes for the Following feed.
  function fetchPage(source, cursor) {
    var feed = window.__flFeed || {};
    var tpl = feed.template;
    var session = freshSession();
    if (!tpl || !session) return Promise.reject(new Error('not ready'));
    var params = new URLSearchParams(tpl.body);
    for (var k in session) params.set(k, session[k]);
    var vars = JSON.parse(params.get('variables'));
    vars.after = cursor || null;
    vars.before = null;
    vars.variant = source === 'home' ? 'home' : 'following';
    vars.data = vars.data || {};
    if (source === 'home') delete vars.data.pagination_source; else vars.data.pagination_source = 'following';
    if ('feed_view_info' in vars.data) vars.data.feed_view_info = '[]';
    params.set('variables', JSON.stringify(vars));
    params.set('__req', Math.floor(Math.random() * 1e6).toString(36));
    var headers = {};
    for (var h in tpl.headers) headers[h] = tpl.headers[h];
    headers['content-type'] = 'application/x-www-form-urlencoded';
    if (params.get('lsd')) headers['x-fb-lsd'] = params.get('lsd');
    var csrf = cookie('csrftoken');
    if (csrf) headers['x-csrftoken'] = csrf;
    // window.fetch is wrapped by privacy-hook.js, which files the page under this cursor.
    return fetch(tpl.url, { method: 'POST', credentials: 'include', headers: headers, body: params.toString() })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        // Wait for privacy-hook.js to file the page, then check it arrived.
        return new Promise(function (resolve, reject) {
          var tries = 0;
          (function check() {
            if ((window.__flFeed.pages[source] || {}).hasOwnProperty(cursor || '')) return resolve();
            if (++tries > 20) return reject(new Error(text.slice(0, 120)));
            setTimeout(check, 50);
          })();
        });
      });
  }

  function setEnd(box) {
    var cfg = FEEDS[ff.mode];
    var end = box.querySelector('.end');
    var hasTpl = !!(window.__flFeed && window.__flFeed.template);
    // Only redraw when what it says changes (this runs every second; redrawing would restart the
    // check's animation).
    var key = [ff.mode, ff.unliked, ff.earlier, ff.collapsed, ff.error, ff.caughtUp, ff.more, hasTpl, ff.showSeen,
      ff.held > 0, ff.cards > 0, ff.r.more, ff.r.started].join(',');
    if (end.dataset.key === key) return;
    end.dataset.key = key;
    end.textContent = '';
    if ((ff.unliked || ff.earlier) && ff.collapsed) return;
    if (ff.earlier && !ff.error) {
      end.textContent = ff.more ? 'Loading more…' : "That's everything for now.";
      return;
    }
    if (ff.unliked && !ff.error) {
      end.textContent = ff.r.more || !ff.r.started ? 'Loading more…' : "That's everything for now.";
      return;
    }
    if (ff.error) {
      end.appendChild(document.createTextNode("Couldn't load more posts. "));
      var retry = el('button', '', 'Try again');
      retry.type = 'button';
      retry.addEventListener('click', function () { ff.error = false; ff.emptyRun = 0; queue(); });
      end.appendChild(retry);
    } else if ((ff.caughtUp || (!ff.more && hasTpl)) && !ff.showSeen && ff.held > 0) {
      end.appendChild(cuMark());
      var t = el('div', '', "You're all caught up");
      t.className = 'cu-t';
      end.appendChild(t);
      end.appendChild(seenLine(ff.mode));
      end.appendChild(document.createTextNode(' '));
      var more = el('button', '', 'Show posts you\'ve seen');
      more.type = 'button';
      more.addEventListener('click', function () {
        ff.showSeen = true; ff.caughtUp = false; ff.seenRun = 0; ff.emptyRun = 0; ff.counted = {};
        queue();
      });
      end.appendChild(more);
      end.appendChild(storyCountEl());
    } else if (!ff.more && hasTpl) {
      if (ff.cards) { end.appendChild(cuMark()); end.appendChild(el('div', 'cu-t', "You're all caught up")); end.appendChild(storyCountEl()); }
      else end.textContent = cfg.none;
    } else if (!ff.cards) {
      end.textContent = cfg.looking;
    } else {
      end.textContent = 'Loading more…';
    }
  }

  // Signed in: Instagram sets the ds_user_id cookie. Signed out, leave Instagram's page alone,
  // so its "Log in" screen shows.
  function signedIn() {
    return /(?:^|; )ds_user_id=/.test(document.cookie);
  }

  // Fetch the first page of the other Home feed in the background, so switching is instant.
  var prefetched = {};
  function prefetchOther(mode) {
    var other = FEEDS[mode === 'friends' ? 'following' : 'friends'].source;
    var pages = (window.__flFeed.pages || {})[other] || {};
    if (prefetched[other] || pages.hasOwnProperty('')) return;
    prefetched[other] = true;
    fetchPage(other, '').catch(function () { prefetched[other] = false; });
  }

  // Refresh in place (pull to refresh, or tapping Home while on Home): ask Instagram again for
  // the first page of this feed, keep the current posts on screen until it arrives, then redraw.
  // Much faster than reloading the whole page. Returns false if it can't (the app then reloads).
  var refreshing = false;
  window.__flRefresh = function () {
    var feed = window.__flFeed || {};
    var ready = !!(feed.template && (feed.live || (feed.common && feed.common.fb_dtsg && !feed.staleTemplate)));
    if (TAB !== 'home' || !onFollowingFeed() || !signedIn() || !ready || !document.getElementById(FF_ID)) return false;
    if (refreshing) return true;
    refreshing = true;
    var mode = feedMode();
    var src = FEEDS[mode].source;
    var other = FEEDS[mode === 'friends' ? 'following' : 'friends'].source;
    var done = function () {
      refreshing = false;
      post({ type: 'refreshed' });
    };
    var start = function (source) {
      // A new first page; the cursor chain then follows its fresh cursors (older pages are left
      // unused).
      delete (feed.pages[source] || {})[''];
      return fetchPage(source, '');
    };
    start(src).then(function () {
      var box = document.getElementById(FF_ID);
      if (box) box.remove();          // redrawn from the new first page on the next step
      ff = freshState(mode);
      if (document.scrollingElement.scrollTop > 0) document.scrollingElement.scrollTop = 0;
      if (!window.__flRefreshedAt) window.__flRefreshedAt = Math.round(performance.now());
      queue();
      done();
      prefetched[other] = true;
      start(other).catch(function () { prefetched[other] = false; });
    }, function () {
      done();
    });
    return true;
  };

  function ownFeedStep() {
    var root = document.documentElement;
    var on = TAB === 'home' && onFollowingFeed() && signedIn();
    var box = document.getElementById(FF_ID);
    if (!on) {
      root.classList.remove('fl-own', 'fl-own-boot');
      if (box) box.remove();
      return;
    }
    var main = document.querySelector('main');
    if (!main) return;
    addModeStyle();
    var mode = feedMode();
    var feed = window.__flFeed || {};
    root.classList.add('fl-own');
    // Ready to fetch: the saved request plus fresh session fields from Instagram's first request
    // on this page (about a second in). Only if there is no saved request yet (first use), or the
    // saved one stopped working, wait for Instagram's own list to make a "load more" request:
    // keep that list laid out but unseen and let it load once.
    var quick = !!(feed.template && feed.common && feed.common.fb_dtsg && !feed.staleTemplate);
    var ready = !!(feed.template && (feed.live || quick));
    if (ready) prefetchOther(mode);
    root.classList.toggle('fl-own-boot', !ready);
    if (!ready && bootNudges < 20 && Date.now() - lastBootNudge > 1500) {
      // Instagram's list asks for more when it sees a scroll near its end.
      bootNudges++;
      lastBootNudge = Date.now();
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    }
    if (!box || !main.contains(box) || box.dataset.mode !== mode) {
      if (box) box.remove();
      ff = freshState(mode);
      box = el('div');
      box.id = FF_ID;
      box.dataset.mode = mode;
      box.appendChild(el('div', 'list'));
      box.appendChild(el('div', 'end'));
      main.insertBefore(box, main.firstChild);
    }
    var list = box.querySelector('.list');
    var added = drawPages(list);
    if (added) ff.emptyRun = 0;
    // Friends: once caught up (or at the end of the feed), carry on with seen, unliked posts.
    if (mode === 'friends' && !ff.unliked && ff.started && (ff.caughtUp || !ff.more)) startUnliked(list);
    if ((mode === 'following' || mode === 'all') && !ff.earlier && ff.started && (ff.caughtUp || !ff.more) && ff.held > 0) {
      startEarlier(list);
      drawPages(list);
    }
    if (ff.unliked && !ff.collapsed && drawUnliked(list)) ff.emptyRun = 0;

    // Load the next page when fewer than two screens of posts are left below.
    var end = box.querySelector('.end');
    var near = end.getBoundingClientRect().top - window.innerHeight < window.innerHeight * 2;
    // A run of pages with nothing to keep: keep going, but stop after 15 until you scroll.
    var source = ff.unliked ? 'home' : FEEDS[mode].source;
    var nextCursor = ff.unliked ? (ff.r.started ? ff.r.next : '') : (ff.started ? ff.next : '');
    var hasMore = ff.unliked ? (ff.r.more && !ff.collapsed) : (ff.more && !ff.caughtUp && !(ff.earlier && ff.collapsed));
    if (near && hasMore && typeof nextCursor === 'string' && !ff.loading && !ff.error && ff.emptyRun < 15 && ready) {
      ff.loading = true;
      var state = ff;
      var before = ff.cards;
      fetchPage(source, nextCursor).then(function () {
        if (state !== ff) return;
        ff.loading = false;
        drawPages(list);
        if (ff.unliked && !ff.collapsed) drawUnliked(list);
        if (ff.cards === before) ff.emptyRun++; else ff.emptyRun = 0;
        queue();
      }, function () {
        if (state !== ff) return;
        ff.loading = false;
        // The saved request didn't work: fall back to learning a fresh one from Instagram's list.
        if (!feed.live && !feed.staleTemplate) { feed.staleTemplate = true; queue(); return; }
        ff.error = true;
        setEnd(box);
      });
    }
    setEnd(box);
  }
  window.addEventListener('scroll', function (e) { if (e.isTrusted && ff.emptyRun >= 15) { ff.emptyRun = 10; queue(); } }, { passive: true });

  // A post opened from the feed's share button: tap Instagram's Share on it once it's there.
  var shareTried = 0;
  function shareStep() {
    if (TAB !== 'stories' || !/^\/p\//.test(location.pathname) || location.search.indexOf('fl_share=1') === -1) return;
    if (window.__flShareDone || shareTried > 40) return;
    shareTried++;
    var svg = document.querySelector('svg[aria-label="Share"]');
    var btn = svg && (svg.closest('[role="button"],button,a') || svg.parentElement);
    if (!btn) return;
    window.__flShareDone = true;
    btn.click();
  }

  // A post opened from the feed's bookmark: tap Instagram's Save (fl_save=1) or Remove
  // (fl_save=0), unless it's already that way, then go back to the feed.
  var saveTried = 0;
  function saveStep() {
    if (TAB !== 'stories' || !/^\/p\//.test(location.pathname)) return;
    var want = /[?&]fl_save=([01])/.exec(location.search);
    if (!want || window.__flSaveDone || saveTried > 40) return;
    saveTried++;
    var save = document.querySelector('svg[aria-label="Save"]');
    var remove = document.querySelector('svg[aria-label="Remove"]');
    if (!save && !remove) return;
    window.__flSaveDone = true;
    var target = want[1] === '1' ? save : remove;
    var dry = false;
    try { dry = localStorage.getItem('following.saveDry') === '1'; } catch (e) {}  // testing only
    if (target && !dry) (target.closest('[role="button"],button,a') || target.parentElement).click();
    window.__flSaveClicked = !!target;
    setTimeout(function () { post({ type: 'closeOverlay' }); }, 700);
  }

  // Instagram's Share dialog: only "Copy link" and "iMessage" along the bottom (no WhatsApp,
  // Messenger, Facebook, Threads, Email, X or "See all").
  var SHARE_HIDE = { 'WhatsApp': 1, 'Messenger': 1, 'Facebook': 1, 'Threads': 1, 'Email': 1, 'X': 1, 'See all': 1 };
  function shareAppsStep() {
    var titles = document.querySelectorAll('[role="dialog"] svg title, [role="dialog"] span');
    for (var i = 0; i < titles.length; i++) {
      if (!SHARE_HIDE[titles[i].textContent.trim()]) continue;
      // The app's tile: the box whose parent holds the whole row.
      var n = titles[i].parentNode;
      while (n && n.parentElement && n.parentElement.childElementCount < 5) n = n.parentElement;
      if (n && n.style && n.style.display !== 'none') n.style.setProperty('display', 'none', 'important');
    }
  }

  // The heart (Notifications) at the top of Home: Safari treats the first tap on it as a hover
  // and drops the click, so a tap opens it directly.
  var tapStart = null;
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    tapStart = t ? { x: t.clientX, y: t.clientY } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href="/notifications/"]');
    var t = e.changedTouches && e.changedTouches[0];
    if (!a || !tapStart || !t || Math.abs(t.clientX - tapStart.x) > 10 || Math.abs(t.clientY - tapStart.y) > 10) return;
    e.preventDefault();
    post({ type: 'haptic', value: 'tap' });   // like the tab bar (the app checks "Haptic on tab switch")
    a.click();
  }, true);

  // Unread chats: the number on Instagram's own Messages button (its tab bar is hidden, but
  // still there), which counts chats with something unread, not messages. Sent to the app for
  // the red badge on the Messages tab.
  var lastDm = -1;
  function dmBadgeStep() {
    var a = document.querySelector('a[href="/direct/inbox/"]');
    if (!a) return;
    var tag = a.querySelector('[aria-label^="Direct messaging"]');
    var m = tag && /(\d+)/.exec(tag.getAttribute('aria-label') || '');
    var n = m ? parseInt(m[1], 10) : 0;
    if (n === lastDm) return;
    lastDm = n;
    post({ type: 'dmBadge', value: n });
  }

  // Your own profile, tapped again in the tab bar: has anything worth reloading for changed?
  // Only your posts (their number) and your profile picture count, not followers. Compares
  // the page as loaded with a fresh copy of it from Instagram (its summary: "7 Posts", and the
  // picture's file). "changed", "same", or "unknown" if it can't tell.
  window.__flProfileChanged = async function () {
    var sig = function (desc, img) {
      var posts = /([\d,.]+[KM]?) Posts?/i.exec(desc || '');
      var file = (img || '').split('?')[0].split('/').pop();
      return posts && file ? posts[1] + '|' + file : null;
    };
    var meta = function (doc, prop) { var m = doc.querySelector('meta[property="' + prop + '"]'); return m && m.content; };
    var now = sig(meta(document, 'og:description'), meta(document, 'og:image'));
    try {
      var html = await (await fetch(location.pathname, { credentials: 'include' })).text();
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var fresh = sig(meta(doc, 'og:description'), meta(doc, 'og:image'));
      if (!now || !fresh) return 'unknown';
      return now === fresh ? 'same' : 'changed';
    } catch (e) { return 'unknown'; }
  };

  // Your own profile (Profile tab): zoomed in like Instagram's app, where exactly five highlights
  // fit across before the row scrolls. The zoom is worked out from the row itself (so it fits
  // any iPhone width): the sixth highlight starts right at the screen's edge. The profile
  // picture is then set to PIC_SIZE points across.
  var PIC_SIZE = 86;
  function ownProfileLookStep() {
    if (TAB !== 'profile') return;
    settingsIconStep();
    var main = document.querySelector('main');
    if (!main) return;
    var own = !!document.querySelector('main a[href="/accounts/edit/"]') ||
      [].some.call(document.querySelectorAll('main [role="button"], main a, main button'), function (b) {
        return (b.textContent || '').trim() === 'Edit profile';
      });
    if (!own) {
      if (main.style.zoom) main.style.removeProperty('zoom');
      delete main.dataset.flSized;   // back on your profile later: worked out again
      main.__flWait = 0;
      main.__flPicZ = 0;
      return;
    }
    // The page's zoom and the picture's: worked out once, from measurements taken before any
    // zoom, and never adjusted again. (Adjusting them again and again from fresh measurements
    // made the whole top of the page, and the picture, grow every second on some iPhones,
    // where measured sizes don't follow the zoom.) Waits for the highlights (up to ~4 s).
    if (!main.dataset.flSized) {
      main.__flWait = (main.__flWait || 0) + 1;
      var links = main.querySelectorAll('a[href*="/stories/highlights/"]');
      var pic0 = main.querySelector('header img[alt*="profile picture" i]') || main.querySelector('header img');
      if ((links.length >= 6 && pic0) || main.__flWait > 4) {
        var mainZ = 1.1;   // fewer than six highlights: nothing to line up, same look
        if (links.length >= 6) {
          var left0 = (links[5].closest('li') || links[5]).getBoundingClientRect().left;
          if (left0 > 0) mainZ = Math.max(1, Math.min(1.3, window.innerWidth / left0));
        }
        var picZ = 1, w0 = pic0 ? pic0.getBoundingClientRect().width : 0;
        if (w0 > 0) picZ = Math.max(0.8, Math.min(1.2, PIC_SIZE / (w0 * mainZ)));
        main.dataset.flSized = '1';
        main.style.zoom = String(Math.round(mainZ * 1000) / 1000);
        main.__flPicZ = picZ;
        // Drawn and sized: the app can drop its saved picture of this page (and take a new one).
        setTimeout(function () { post({ type: 'profileReady' }); }, 300);
      }
    }
    // Less empty space above the picture: no gap above the header, and no "Note..." bubble
    // (it also reserved a band of space above the picture).
    var header = main.querySelector('header');
    if (header && !header.dataset.flTight) {
      header.dataset.flTight = '1';
      header.style.setProperty('margin-top', '0', 'important');
    }
    if (header) {
      var note = [].filter.call(header.querySelectorAll('div, span'), function (e) {
        return e.childElementCount === 0 && /^Note\.\.\.$/.test((e.textContent || '').trim());
      })[0];
      // The bubble: the box around the text that's still small (not the picture's column).
      var bubble = note, nb = null;
      for (var q = 0; q < 6 && bubble; q++) {
        var br = bubble.getBoundingClientRect();
        if (br.width > 0 && br.width < 140 && br.height < 60) nb = bubble;
        bubble = bubble.parentElement;
      }
      if (nb && nb.style.display !== 'none') nb.style.setProperty('display', 'none', 'important');
      // Its wrapper kept the band of space too: in the picture's column, hide everything that
      // isn't the picture.
      var pimg = header.querySelector('img');
      var colm = pimg, pcol = null;
      for (var c = 0; c < 10 && colm && colm !== header; c++) {
        colm = colm.parentElement;
        if (colm && colm.getBoundingClientRect().width < window.innerWidth / 2) pcol = colm;
      }
      if (pcol && nb) {
        [].forEach.call(pcol.querySelectorAll('*'), function (e) {
          if (e.contains(pimg) || pimg.contains(e) || e.style.display === 'none') return;
          if (e.contains(nb) || nb.contains(e)) e.style.setProperty('display', 'none', 'important');
        });
      }
    }
    // The stats (posts / followers / following): spread across, clear of the right edge.
    if (header) {
      var stat = [].filter.call(header.querySelectorAll('a, span, div, li'), function (e) {
        return e.textContent.length < 30 && /following\s*$/.test(e.textContent.trim());
      }).pop();
      var row = stat;
      for (var k = 0; k < 4 && row; k++) {
        row = row.parentElement;
        if (row && row.childElementCount === 3 && getComputedStyle(row).display === 'flex') break;
      }
      if (row && row.childElementCount === 3 && !row.dataset.flStats) {
        row.dataset.flStats = '1';
        // Full width of its column, the three spread evenly, clear of the right edge.
        row.style.setProperty('width', '100%', 'important');
        row.style.setProperty('box-sizing', 'border-box', 'important');
        row.style.setProperty('justify-content', 'space-between', 'important');
        row.style.setProperty('padding-right', '16px', 'important');
        row.style.setProperty('gap', '10px', 'important');
        [].forEach.call(row.querySelectorAll('*'), function (e) { e.style.setProperty('white-space', 'nowrap', 'important'); });
      }
    }
    // The profile picture, PIC_SIZE points across.
    var pic = main.querySelector('header img[alt*="profile picture" i]') || main.querySelector('header img');
    if (pic) {
      if (!pic.__flBox) {
        var box = pic, best = null;
        for (var i = 0; i < 5 && box && box !== main; i++) {
          box = box.parentElement;
          var r = box && box.getBoundingClientRect();
          if (r && r.width < innerWidth / 2.5) best = box;
        }
        pic.__flBox = best;
      }
      var b = pic.__flBox;
      // Its zoom was worked out along with the page's (above); applied once.
      if (b && !b.dataset.flPic && main.__flPicZ) {
        b.dataset.flPic = '1';
        if (Math.abs(main.__flPicZ - 1) > 0.01) b.style.zoom = String(Math.round(main.__flPicZ * 1000) / 1000);
      }

    }
  }

  // Feedback from the refresh page: the author's profile opened with ?fl_dm=1. Tap its "Message"
  // button once, which opens the chat here (nothing is sent).
  var dmTried = 0;
  function feedbackDmStep() {
    if (TAB !== 'messages' || location.search.indexOf('fl_dm=1') === -1 || window.__flDmDone || dmTried > 40) return;
    dmTried++;
    var btn = [].filter.call(document.querySelectorAll('main [role="button"], main button, main a'), function (b) {
      return (b.textContent || '').trim() === 'Message';
    })[0];
    if (!btn) return;
    window.__flDmDone = true;
    btn.click();
  }

  // Your profile (Profile tab): a Following icon in the top right (where Threads was) that opens
  // the app's settings.
  function settingsIconStep() {
    var own = !!document.querySelector('main a[href="/accounts/edit/"]') ||
      [].some.call(document.querySelectorAll('main [role="button"], main a, main button'), function (b) {
        return (b.textContent || '').trim() === 'Edit profile';
      });
    var btn = document.getElementById('fl-settings');
    var info = document.getElementById('fl-info');
    if (!own) { if (btn) btn.remove(); if (info) info.remove(); return; }
    if (btn) return;
    // Level with the settings gear in the top left.
    var gear = document.querySelector('svg[aria-label="Options"], svg[aria-label="Settings"]');
    var top = gear ? gear.getBoundingClientRect() : null;
    btn = document.createElement('button');
    btn.id = 'fl-settings';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Following settings');
    btn.style.cssText = 'all:unset;position:absolute;right:16px;width:28px;height:28px;z-index:2147483000;cursor:pointer;-webkit-tap-highlight-color:transparent;top:' +
      (top && top.height ? Math.round(top.top + top.height / 2 - 14 + window.scrollY) : 10) + 'px';
    btn.innerHTML = '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><defs><linearGradient id="flg" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#6A36C2"/><stop offset=".3" stop-color="#B22FA8"/><stop offset=".55" stop-color="#E1306C"/><stop offset=".8" stop-color="#F77737"/><stop offset="1" stop-color="#FCB045"/></linearGradient></defs>' +
      '<rect width="28" height="28" rx="7" fill="url(#flg)"/><g fill="#fff"><rect x="6.4" y="9.2" width="13.7" height="1.9" rx=".95"/><rect x="6.4" y="13.1" width="13.7" height="1.9" rx=".95"/><rect x="6.4" y="17" width="8.8" height="1.9" rx=".95"/></g></svg>';
    document.body.appendChild(btn);
    // To its left, (i): the app's "How to refresh" page.
    info = document.createElement('button');
    info.id = 'fl-info';
    info.type = 'button';
    info.setAttribute('aria-label', 'How to refresh');
    info.textContent = 'i';
    info.style.cssText = 'all:unset;position:absolute;right:56px;width:22px;height:22px;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
      'border:2px solid var(--fl-strong);border-radius:50%;box-sizing:border-box;color:var(--fl-strong);font:700 13px/1 Georgia,serif;cursor:pointer;-webkit-tap-highlight-color:transparent;top:' +
      (parseInt(btn.style.top, 10) + 3) + 'px';
    document.body.appendChild(info);
  }

  // The Messages list: no back arrow (it led somewhere odd).
  function inboxBackStep() {
    if (TAB !== 'messages' || !/^\/direct\/inbox\/?$/.test(location.pathname)) return;
    var back = document.querySelector('svg[aria-label="Back"]');
    var b = back && (back.closest('a,[role="button"],button') || back.parentElement);
    if (b && b.style.visibility !== 'hidden') b.style.setProperty('visibility', 'hidden', 'important');
  }

  // A profile's picture, full screen (as in Instagram's app): hold it on any profile, or tap it
  // when it has no story (with a story, a tap still opens the story; on your own profile, a tap
  // still changes your photo). The picture on the page is already full size. Tap to close.
  function headerPic() {
    var imgs = document.querySelectorAll('main img[alt$="profile picture"]');
    for (var i = 0; i < imgs.length; i++) {
      var r = imgs[i].getBoundingClientRect();
      if (r.width >= 56 && r.top < 400) return imgs[i];
    }
    return null;
  }
  function showPic(src) {
    if (!src || document.getElementById('fl-pic')) return;
    var box = el('div');
    box.id = 'fl-pic';
    var img = el('img');
    img.src = src;
    img.alt = '';
    box.appendChild(img);
    box.__flTap = function () {
      box.classList.remove('on');
      setTimeout(function () { box.remove(); }, 220);
    };
    box.onclick = box.__flTap;
    document.body.appendChild(box);
    requestAnimationFrame(function () { requestAnimationFrame(function () { box.classList.add('on'); }); });
  }
  var picPress = null;
  document.addEventListener('touchstart', function (e) {
    picPress = null;
    var t = e.touches && e.touches[0];
    if (!t || e.touches.length !== 1 || document.getElementById('fl-pic')) return;
    var pic = headerPic();
    if (!pic) return;
    var r = pic.getBoundingClientRect();
    if (t.clientX < r.left || t.clientX > r.right || t.clientY < r.top || t.clientY > r.bottom) return;
    pic.style.webkitTouchCallout = 'none';
    var p = picPress = { x: t.clientX, y: t.clientY, pic: pic, held: false };
    p.timer = setTimeout(function () {
      if (picPress !== p) return;
      p.held = true;
      post({ type: 'haptic', value: 'tap' });
      showPic(pic.currentSrc || pic.src);
    }, 400);
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', function (e) {
    var t = e.touches && e.touches[0];
    if (picPress && !picPress.held && t && (Math.abs(t.clientX - picPress.x) > 10 || Math.abs(t.clientY - picPress.y) > 10)) {
      clearTimeout(picPress.timer);
      picPress = null;
    }
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var p = picPress;
    picPress = null;
    if (!p) return;
    clearTimeout(p.timer);
    // Held: the picture is already open; the lift shouldn't also tap the page underneath.
    if (p.held) { e.preventDefault(); e.stopPropagation(); return; }
    // A tap: only when the picture is just a link to this same profile (no story, not yours).
    var a = p.pic.closest('a[href]');
    if (!a || p.pic.closest('[role="button"],button')) return;
    var path = function (s) { return s.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); };
    if (path(a.getAttribute('href') || '') !== path(location.pathname)) return;
    e.preventDefault();
    e.stopPropagation();
    showPic(p.pic.currentSrc || p.pic.src);
  }, true);

  // The app's own floating buttons (settings icon, 2× speed): Instagram's page swallows their
  // taps, so a tap is caught on the whole document first (as for the heart).
  var ownTapStart = null;
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    ownTapStart = t ? { x: t.clientX, y: t.clientY } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var b = e.target && e.target.closest && e.target.closest('#fl-settings, #fl-info, #fl-speed, .fl-mute-row, #fl-confirm button, #fl-offline .btn, .fl-offitem, #fl-pic');
    var t = e.changedTouches && e.changedTouches[0];
    if (!b || !ownTapStart || !t || Math.abs(t.clientX - ownTapStart.x) > 10 || Math.abs(t.clientY - ownTapStart.y) > 10) return;
    e.preventDefault();
    e.stopPropagation();
    if (b.id === 'fl-settings') post({ type: 'showSettings' });
    else if (b.id === 'fl-info') post({ type: 'showGuide' });
    else if (b.classList.contains('fl-mute-row')) b.__flTap();
    else if (b.__flTap) b.__flTap(e);
  }, true);

  // Likes on Instagram's own pages (a profile's posts, a shared post, a story): a light tap for
  // each like, and before liking a post over a week old, a warning to confirm it. (The Home feed
  // is the app's own; its likes tap in toggleLike.)
  var likeLetThrough = null;
  function likeButtonOf(t) {
    var b = t && t.closest && t.closest('[role="button"],button');
    if (!b || b.closest('#fl-ff, #fl-menu, #fl-confirm')) return null;
    return b.querySelector('svg[aria-label="Like"]') ? b : null;
  }
  // The post's date: the nearest date above the button (each post on the page has its own).
  function postDateOf(b) {
    for (var n = b.parentElement; n && n !== document.body; n = n.parentElement) {
      var t = n.querySelector('time[datetime]');
      if (t) { var d = new Date(t.getAttribute('datetime')); return isNaN(d) ? null : d; }
    }
    return null;
  }
  function ageText(ms) {
    var day = 864e5, n, unit;
    if (ms >= 365 * day) { n = Math.floor(ms / (365 * day)); unit = 'year'; }
    else if (ms >= 30 * day) { n = Math.floor(ms / (30 * day)); unit = 'month'; }
    else { n = Math.floor(ms / (7 * day)); unit = 'week'; }
    return n + ' ' + unit + (n === 1 ? '' : 's');
  }
  function confirmOldLike(b, age) {
    confirmAction('This post is ' + ageText(age) + ' old. Are you sure you want to like it?', 'Like',
      function () { likeLetThrough = b; b.click(); });
  }
  // A small "Are you sure?" card: the action in red, Cancel in bold blue.
  function confirmAction(text, okLabel, onOk) {
    var old = document.getElementById('fl-confirm');
    if (old) old.remove();
    var box = el('div');
    box.id = 'fl-confirm';
    var card = el('div', 'card');
    card.appendChild(el('div', 'msg', text));
    var close = function () { box.classList.remove('on'); setTimeout(function () { box.remove(); }, 180); };
    var like = el('button', 'like', okLabel);
    var cancel = el('button', 'cancel', 'Cancel');
    like.__flTap = function () { close(); onOk(); };
    cancel.__flTap = close;
    like.onclick = like.__flTap;
    cancel.onclick = cancel.__flTap;
    card.appendChild(like);
    card.appendChild(cancel);
    box.appendChild(card);
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    document.body.appendChild(box);
    requestAnimationFrame(function () { box.classList.add('on'); });
  }
  (function () {
    var st = document.createElement('style');
    st.textContent = [
      '#fl-confirm{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0);transition:background .18s}',
      '#fl-confirm.on{background:rgba(0,0,0,.4)}',
      '#fl-pic{position:fixed;inset:0;z-index:2147483600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0);-webkit-backdrop-filter:blur(0);backdrop-filter:blur(0);transition:background .2s,backdrop-filter .2s,-webkit-backdrop-filter .2s}',
      '#fl-pic.on{background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}',
      '#fl-pic img{width:min(78vw,360px);height:min(78vw,360px);border-radius:50%;object-fit:cover;transform:scale(.4);opacity:0;transition:transform .22s cubic-bezier(.2,.9,.3,1.15),opacity .18s;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}',
      '#fl-pic.on img{transform:none;opacity:1}',
      '#fl-confirm .card{width:270px;background:var(--fl-sheet,#fff);border-radius:14px;overflow:hidden;text-align:center;font:400 17px/1.3 -apple-system,system-ui,sans-serif;color:var(--fl-strong);transform:scale(1.1);opacity:0;transition:transform .18s,opacity .18s}',
      '#fl-confirm.on .card{transform:none;opacity:1}',
      '#fl-confirm .msg{padding:20px 16px 18px;font-size:15px;font-weight:600}',
      '#fl-confirm button{all:unset;display:block;width:100%;box-sizing:border-box;padding:12px;border-top:.5px solid rgba(127,127,127,.35);cursor:pointer;-webkit-tap-highlight-color:transparent}',
      '#fl-confirm button:active{background:rgba(127,127,127,.15)}',
      '#fl-confirm button.like{color:#ed4956}',
      '#fl-confirm button.cancel{color:#0095f6;font-weight:700}',
      '@media (prefers-color-scheme: dark){#fl-confirm .card{--fl-sheet:#262626}}'
    ].join('');
    (document.head || document.documentElement).appendChild(st);
  })();
  document.addEventListener('click', function (e) {
    var b = likeButtonOf(e.target);
    if (!b) return;
    if (likeLetThrough === b) { likeLetThrough = null; post({ type: 'haptic', value: 'like' }); return; }
    var when = /^\/stories\//.test(location.pathname) ? null : postDateOf(b);
    var age = when ? Date.now() - when.getTime() : 0;
    if (age > 7 * 864e5) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      confirmOldLike(b, age);
      return;
    }
    post({ type: 'haptic', value: 'like' });
  }, true);

  // Repost: always asks first (it puts the post on your own profile for everyone to see).
  // Undoing a repost doesn't ask.
  var repostLetThrough = null;
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('[role="button"],button');
    if (!t || t.closest('#fl-confirm') || !t.querySelector('svg[aria-label="Repost"]')) return;
    if (repostLetThrough === t) { repostLetThrough = null; return; }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    confirmAction('Are you sure you want to repost this? It will show on your profile.', 'Repost',
      function () { repostLetThrough = t; t.click(); });
  }, true);

  // 2× speed: a small button over a big playing video (a reel a friend sent, a post's video).
  // Tap to switch between 1× and 2×; the choice holds for the rest of this page's videos.
  // Swiping between a post's photos on Instagram's own pages (Explore, profiles, shared posts):
  // its arrows work but its swipe often doesn't in the app, so a sideways swipe presses the arrow,
  // unless the photos already moved by themselves.
  var swipe = null;
  function carouselOf(t) {
    for (var n = t; n && n !== document.body; n = n.parentElement) {
      if (n.querySelector && n.querySelector('button[aria-label="Next"], button[aria-label="Go back"]')) return n;
    }
    return null;
  }
  function slideSpot(box) {
    var ul = box.querySelector('ul');
    return ul ? [].map.call(ul.children, function (li) { return Math.round(li.getBoundingClientRect().left); }).join(',') : '';
  }
  document.addEventListener('touchstart', function (e) {
    swipe = null;
    if (TAB === 'stories' || !e.touches || e.touches.length !== 1) return;
    var t = e.target;
    if (!t || !t.closest || t.closest('#fl-ff, [role="dialog"] video') || !t.closest('ul li')) return;
    var box = carouselOf(t);
    if (!box) return;
    swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, box: box, spot: slideSpot(box), at: Date.now() };
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var sw = swipe;
    swipe = null;
    var t = e.changedTouches && e.changedTouches[0];
    if (!sw || !t) return;
    var dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - sw.at > 1200) return;
    setTimeout(function () {
      if (slideSpot(sw.box) !== sw.spot) return;   // Instagram's own swipe worked
      var b = sw.box.querySelector(dx < 0 ? 'button[aria-label="Next"]' : 'button[aria-label="Go back"]');
      if (b) b.click();
    }, 250);
  }, true);

  // A post page scrolls (to read the caption), and swiping up once you're at the bottom goes
  // back, as it did before posts could scroll. A post too short to scroll is at its bottom
  // straight away, so one swipe up goes back.
  var postSwipe = null;
  function atPostBottom() {
    var se = document.scrollingElement || document.documentElement;
    return Math.ceil(se.scrollTop + window.innerHeight) >= se.scrollHeight - 4;
  }
  document.addEventListener('touchstart', function (e) {
    postSwipe = null;
    if (!/^\/p\/[^/]+\/?$/.test(location.pathname) || !e.touches || e.touches.length !== 1) return;
    if (document.querySelector('[role="dialog"]')) return;   // comments, share sheet and the like
    var t = e.touches[0];
    postSwipe = { x: t.clientX, y: t.clientY, at: Date.now(), bottom: atPostBottom() };
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var s = postSwipe;
    postSwipe = null;
    var t = e.changedTouches && e.changedTouches[0];
    if (!s || !t || !s.bottom) return;
    var dy = t.clientY - s.y, dx = Math.abs(t.clientX - s.x);
    if (dy < -60 && dx < Math.abs(dy) && Date.now() - s.at < 1000) history.back();
  }, true);

  // Each new post or reel starts at 1×; the button always shows the speed of the video on screen.
  var playRate = 1, ratePath = location.pathname;
  function samePage() {
    if (location.pathname !== ratePath) { ratePath = location.pathname; playRate = 1; }
  }
  document.addEventListener('playing', function (e) {
    var v = e.target;
    samePage();
    if (v && v.tagName === 'VIDEO' && !v.closest('#fl-ff') && v.playbackRate !== playRate) v.playbackRate = playRate;
  }, true);
  function bigVideo() {
    var best = null, bestH = 0;
    [].forEach.call(document.querySelectorAll('video'), function (v) {
      if (v.closest('#fl-ff')) return;
      var r = v.getBoundingClientRect();
      var top = Math.max(r.top, 80), bottom = Math.min(r.bottom, window.innerHeight - 80);
      if (r.height > 240 && bottom - top > bestH) { best = v; bestH = bottom - top; }
    });
    return best;
  }
  function showRate(btn, rate) {
    var two = rate > 1.5;
    btn.textContent = two ? '2×' : '1×';
    btn.style.background = two ? 'rgba(225,48,108,.9)' : 'rgba(0,0,0,.6)';
  }
  function speedButtonStep() {
    var btn = document.getElementById('fl-speed');
    samePage();
    // Not on stories (the story row, or a story open), only reels and videos.
    if (/^\/stories\//.test(location.pathname) || TAB === 'stories' && location.pathname === '/') {
      if (btn) btn.style.display = 'none';
      return;
    }
    var cur = bigVideo();
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'fl-speed';
      btn.type = 'button';
      btn.style.cssText = 'all:unset;position:fixed;right:14px;top:140px;z-index:2147483000;min-width:44px;height:32px;padding:0 12px;box-sizing:border-box;' +
        'border-radius:16px;background:rgba(0,0,0,.6);color:#fff;font:700 15px/32px -apple-system,system-ui,sans-serif;text-align:center;-webkit-tap-highlight-color:transparent';
      btn.__flTap = function (e) {
        e.preventDefault(); e.stopPropagation();
        var v = bigVideo();
        playRate = (v ? v.playbackRate : playRate) > 1.5 ? 1 : 2;
        [].forEach.call(document.querySelectorAll('video'), function (x) { if (!x.closest('#fl-ff')) setRateKeepingSpot(x, playRate); });
        showRate(btn, playRate);
      };
      document.body.appendChild(btn);
    }
    if (cur) showRate(btn, cur.playbackRate);
    btn.style.display = cur ? 'block' : 'none';
  }

  // Someone's profile, their "..." menu: Instagram's "Embed" row becomes "Mute account" /
  // "Unmute account" (their posts and stories), checked with Instagram when the menu opens.
  var RESERVED = /^(explore|direct|accounts|p|reel|reels|stories|about|legal|developer|web|challenge|emails|session|notifications)$/;
  function profileMenuStep() {
    var mm = /^\/([A-Za-z0-9._]+)\/?$/.exec(location.pathname);
    if (!mm || RESERVED.test(mm[1])) return;
    var dialog = document.querySelector('[role="dialog"]');
    if (!dialog || dialog.querySelector('.fl-mute-row')) return;
    var embed = [].filter.call(dialog.querySelectorAll('button, [role="button"]'), function (b) {
      return (b.textContent || '').trim() === 'Embed';
    })[0];
    if (!embed) return;
    var username = mm[1].toLowerCase();
    var id = (window.__flUserIds || {})[username];
    if (!id) return;
    // A copy without Instagram's own Embed action.
    var row = embed.cloneNode(true);
    row.classList.add('fl-mute-row');
    embed.parentNode.replaceChild(row, embed);
    var leaf = [].filter.call(row.querySelectorAll('*'), function (e) { return e.childElementCount === 0 && e.textContent.trim() === 'Embed'; })[0] || row;
    var muted = null;
    leaf.textContent = 'Mute account';
    igGet('/api/v1/friendships/show/' + id + '/').then(function (j) {
      muted = !!(j && (j.muting || j.is_muting_reel));
      leaf.textContent = muted ? 'Unmute account' : 'Mute account';
    }, function () { muted = false; });
    row.__flTap = function () {
      if (row.__busy) return;
      row.__busy = true;
      var on = !muted;
      leaf.textContent = on ? 'Muting…' : 'Unmuting…';
      igAction('/api/v1/friendships/' + (on ? 'mute' : 'unmute') + '_posts_or_story_from_follow/',
        { target_posts_author_id: id, target_reel_author_id: id }).then(function () {
        muted = on;
        reportMuted(id, mm[1], on);
        leaf.textContent = on ? 'Muted' : 'Unmuted';
        setTimeout(function () {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        }, 700);
      }, function () { leaf.textContent = "Couldn't do that, try again"; })
        .then(function () { row.__busy = false; });
    };
    row.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); row.__flTap(); }, true);
  }

  /* ---------- run ---------- */
  var queued = false;
  function tick() {
    queued = false;
    if (isAuthPage()) return;
    routeMarkStep();
    followingRedirect();
    hideBottomBar();
    hideAppPrompts();
    cleanFeed();
    profileStep();
    focusSearch();
    spacerStep();
    stripStep();
    modeSwitchStep();
    ownFeedStep();
    shareStep();
    saveStep();
    shareAppsStep();
    if (TAB === 'home' || TAB === 'messages') dmBadgeStep();
    ownProfileLookStep();
    feedbackDmStep();
    inboxBackStep();
    profileMenuStep();
    speedButtonStep();
    // The app's feed is in place (or this isn't the Home feed): show the page.
    if (!feedCoverNeeded()) document.documentElement.classList.remove('fl-early');
  }

  // Coming back to the Home feed inside the page (back from Notifications, say): Instagram
  // draws its own home page (a reel, its own tab bar) for a moment before the app's feed is
  // back. Keep the page hidden from the moment the address changes until it is.
  function feedCoverNeeded() {
    if (TAB !== 'home' || !onFollowingFeed() || !signedIn()) return false;
    var box = document.getElementById(FF_ID), main = document.querySelector('main');
    return !(box && main && main.contains(box));
  }
  var coverTimer = 0;
  function coverFeed() {
    if (!feedCoverNeeded()) return;
    if (!document.getElementById('fl-cover-style')) {
      var cs = document.createElement('style');
      cs.id = 'fl-cover-style';
      cs.textContent = 'html.fl-early body{opacity:0 !important}';
      (document.head || document.documentElement).appendChild(cs);
    }
    document.documentElement.classList.add('fl-early');
    clearTimeout(coverTimer);
    // Never stay hidden.
    coverTimer = setTimeout(function () { document.documentElement.classList.remove('fl-early'); }, 2500);
    queue();
  }
  if (TAB === 'home') {
    ['pushState', 'replaceState'].forEach(function (name) {
      var orig = history[name];
      history[name] = function () {
        var r = orig.apply(this, arguments);
        try { coverFeed(); } catch (e) {}
        return r;
      };
    });
    window.addEventListener('popstate', function () { try { coverFeed(); } catch (e) {} }, true);
  }
  function queue() {
    if (queued) return;
    queued = true;
    setTimeout(tick, 150);
  }

  window.__flKick = queue;
  tick();
  new MutationObserver(queue).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', queue);
  setInterval(queue, 1000);
})();
