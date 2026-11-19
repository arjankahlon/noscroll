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
    location.replace('/?variant=following');
  }

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
      if ((r.seen && (r.seen >= r.latest_reel_media || r.seen > dayAgo)) || storySeen[u.username]) seenN++;
    });
    var c = document.getElementById('fl-story-count');
    if (!c) {
      c = document.createElement('div');
      c.id = 'fl-story-count';
      c.style.cssText = 'position:absolute;top:4px;left:14px;z-index:5;font:600 12px/16px -apple-system,system-ui,sans-serif;color:#737373;pointer-events:none';
      document.body.appendChild(c);
    }
    var text = 'Stories: ' + seenN + '/' + total + ' seen';
    if (c.textContent !== text) {
      c.textContent = text;
      // The app passes it on to the Home feed, for under "You're all caught up".
      post({ type: 'storyCount', value: text });
    }
    // Room for the count above the circles.
    box.style.setProperty('padding-top', '18px', 'important');
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
  function feedMode() {
    try { return sessionStorage.getItem(MODE_KEY) === 'following' ? 'following' : 'friends'; } catch (e) { return 'friends'; }
  }
  function setFeedMode(m) {
    try { sessionStorage.setItem(MODE_KEY, m); } catch (e) {}
    document.scrollingElement.scrollTop = 0;
    queue();
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
      '#fl-ff .dots{display:flex;justify-content:center;gap:4px;padding-top:8px}',
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
      '#fl-ff .cu-t{font-weight:600;font-size:16px;margin-bottom:4px;color:#1f9d55}',
      '#fl-ff .cu-ic{display:block;width:56px;height:56px;margin:0 auto 10px}',
      '#fl-ff .cu-st{margin-top:14px;font-size:16px;font-weight:600;color:#000}',
      '#fl-ff .cu-st:empty{display:none}',
      '#fl-ff .cu-s button{all:unset;cursor:pointer;display:block;margin:10px auto 0;color:#0095f6;font-weight:600}',
      '#fl-ff .cu-s{color:#737373;font-size:14px;line-height:1.4}',
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
      [['friends', 'Friends'], ['following', 'Following']].forEach(function (pair) {
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
  var BIO_MAX_FOLLOWERS = 4000;
  function bioLine(u) {
    var p = profileOf(u);
    if (!p || !p.b) return '';
    var priv = typeof u.is_private === 'boolean' ? u.is_private :
      (window.__flPrivacy || {})[(u.username || '').toLowerCase()] === true;
    if (!priv && !(p.f < BIO_MAX_FOLLOWERS)) return '';
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

  function toggleLike(m, btn, label) {
    var want = !m.has_liked;
    var setUi = function (liked) {
      m.has_liked = liked;
      btn.classList.toggle('on', liked);
      btn.replaceChild(icon(HEART, liked), btn.firstChild);
      btn.setAttribute('aria-label', liked ? 'Unlike' : 'Like');
    };
    setUi(want);
    if (typeof m.like_count === 'number') { m.like_count += want ? 1 : -1; label(); }
    likeRequest(want ? 'like' : 'unlike', m).catch(function (err) {
      try { window.__flLikeError = String(err && err.message || err); } catch (e) {}
      setUi(!want);
      if (typeof m.like_count === 'number') { m.like_count += want ? -1 : 1; label(); }
    });
  }

  function card(m) {
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
    var loc = m.location;
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
    cm.addEventListener('click', function (e) { e.preventDefault(); openOver('/p/' + m.code + '/'); });
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
      vc.addEventListener('click', function (e) { e.preventDefault(); openOver('/p/' + m.code + '/'); });
      p.appendChild(vc);
    }
    // 3 days old or more ("3 days ago", or a date): bold red, so older posts stand out.
    if (m.taken_at) p.appendChild(el('span', 'ago' + (Math.round((Date.now() / 1000 - m.taken_at) / 86400) >= 3 ? ' old' : ''), ago(m.taken_at)));
    return p;
  }

  // Both Home feeds are drawn by the app from Instagram's feed data:
  //   Friends:   newest first (Instagram's Following feed), keeping only private accounts.
  //   Following: Instagram's suggested order (its ranked feed, as in the app's main feed), keeping
  //              only accounts you follow (no "Suggested for you" posts, no ads).
  var FEEDS = {
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
        if (already && ff.earlier && m.has_liked) continue;
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

  // The green check over "You're all caught up" (a ring with a tick, like Instagram's).
  function cuMark() {
    var d = document.createElement('div');
    d.innerHTML = '<svg class="cu-ic" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="45" fill="none" stroke="#1f9d55" stroke-width="3"/>' +
      '<path d="M30 49.5l12 12 24-26" fill="none" stroke="#1f9d55" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return d.firstChild;
  }

  // Friends, after "You're all caught up": earlier posts from friends that you've seen
  // but not liked, in Instagram's suggested order (the ranked feed), under a divider.
  function startUnliked(list) {
    if (!window.__flFirstCard) window.__flFirstCard = Math.round(performance.now());
    ff.unliked = true;
    ff.caughtUp = false;
    ff.emptyRun = 0;
    caughtUpDivider(list, 'from your friends');
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
    caughtUpDivider(list, '');
  }

  function caughtUpDivider(list, from) {
    // At the top (nothing new above it, as after a refresh or reopening the app): keep the
    // earlier posts folded away until "View earlier posts".
    ff.collapsed = ff.cards === 0;
    var d = el('div', 'cu');
    d.appendChild(cuMark());
    d.appendChild(el('div', 'cu-t', "You're all caught up"));
    var seenText = "You've seen the new posts" + (from ? ' ' + from : '') + '.';
    var sub = el('div', 'cu-s', ff.collapsed ? seenText : seenText + " Here are earlier ones you haven't liked yet.");
    if (ff.collapsed) {
      var open = el('button', '', 'View earlier posts');
      open.type = 'button';
      open.addEventListener('click', function () {
        ff.collapsed = false;
        sub.textContent = "Here are earlier posts" + (from ? ' ' + from : '') + " you haven't liked yet.";
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
        if (ff.shown[m.code] || m.has_liked || !(seen[m.code] || m.is_seen === true)) continue;
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
    end.textContent = '';
    var hasTpl = !!(window.__flFeed && window.__flFeed.template);
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
      end.appendChild(document.createTextNode("You've seen the new posts. "));
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
      document.scrollingElement.scrollTop = 0;
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
    if (mode === 'following' && !ff.earlier && ff.started && (ff.caughtUp || !ff.more) && ff.held > 0) {
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

  // No Repost, anywhere in the app (Instagram's post pages and Reels have one).
  function noRepostStep() {
    var icons = document.querySelectorAll('svg[aria-label="Repost"]');
    for (var i = 0; i < icons.length; i++) {
      var b = icons[i].closest('[role="button"],button,a') || icons[i].parentElement;
      if (b && b.style.display !== 'none') b.style.setProperty('display', 'none', 'important');
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
    a.click();
  }, true);

  // Ads between people's stories: skip them (tap "Next" as soon as one shows).
  var lastAdSkip = 0;
  function storyAdStep() {
    if (!/^\/stories\//.test(location.pathname) || Date.now() - lastAdSkip < 800) return;
    var header = document.querySelector('section') || document.body;
    var texts = leafTexts(header, 80);
    var ad = texts.some(function (p) { return p[0] === 'Sponsored' && p[1].getBoundingClientRect().top < window.innerHeight / 3; });
    if (!ad) return;
    var next = document.querySelector('svg[aria-label="Next"]');
    var btn = next && (next.closest('[role="button"],button') || next.parentElement);
    if (!btn) return;
    lastAdSkip = Date.now();
    btn.click();
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
    noRepostStep();
    storyAdStep();
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
