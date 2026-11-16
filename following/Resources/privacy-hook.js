/*
 * Following: reads the data Instagram's own page downloads. Runs at document start, before
 * Instagram's code, in every tab. It sends nothing anywhere and asks for nothing extra by itself.
 *
 * 1. Privacy: any object with a "username" and an "is_private" true/false is recorded in
 *    window.__flPrivacy and kept in localStorage ("following.privacy").
 * 2. Feed pages (for the Friends feed in extras.js): every page of the Following feed and of the
 *    ranked feed this page receives is kept in window.__flFeed.pages.following / .home, keyed by
 *    the cursor it was asked for with ('' for the first page).
 * 4. Like requests: the id and headers of Instagram's own like and unlike requests are kept in
 *    localStorage ("following.likeTpl.like" / ".unlike") for the Friends feed's heart.
 * 3. How to ask for the next page: the request Instagram makes for it (address, form fields,
 *    headers) is kept in window.__flFeed.template and in localStorage ("following.feedTemplate"),
 *    and the session fields of Instagram's latest request in window.__flFeed.common, so the
 *    Friends feed can repeat it with another cursor.
 */
(function () {
  if (window.__flPrivacyHook) return;
  // Debugging only: localStorage "following.plain" = "2" turns this off for testing.
  try { if (localStorage.getItem('following.plain') === '2') return; } catch (e) {}
  window.__flPrivacyHook = true;

  /* ---------- 1. Privacy ---------- */
  var KEY = 'following.privacy';
  var map = {};
  try { map = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { map = {}; }
  window.__flPrivacy = map;

  var dirty = false;
  function save() {
    if (!dirty) return;
    dirty = false;
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) {}
  }
  setInterval(save, 3000);
  addEventListener('pagehide', save);

  /* ---------- 2. Feed pages ---------- */
  // pages.following: the Following feed (newest first). pages.home: the ranked feed (Instagram's
  // suggested order), which only the Friends feed asks for.
  var feed = window.__flFeed = { pages: { following: {}, home: {} }, template: null, common: null, version: 0 };
  try { feed.template = JSON.parse(localStorage.getItem('following.feedTemplate') || 'null'); } catch (e) {}

  function walk(node, depth, ctx) {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) walk(node[i], depth + 1, ctx);
      return;
    }
    if (typeof node.username === 'string' && typeof node.is_private === 'boolean') {
      var u = node.username.toLowerCase();
      if (map[u] !== node.is_private) { map[u] = node.is_private; dirty = true; }
    }
    var conn = node.xdt_api__v1__feed__timeline__connection;
    if (conn && typeof conn === 'object' && conn.edges) keepPage(conn, ctx);
    for (var k in node) {
      var v = node[k];
      if (v && typeof v === 'object') walk(v, depth + 1, ctx);
    }
  }

  function keepPage(conn, ctx) {
    var source = (ctx && ctx.source) || (conn.pagination_source === 'following' || !conn.pagination_source ? 'following' : '');
    if (!feed.pages[source]) return;
    var items = [];
    for (var i = 0; i < conn.edges.length; i++) {
      var m = conn.edges[i] && conn.edges[i].node && conn.edges[i].node.media;
      if (m && m.code && m.user) items.push(m);
    }
    var info = conn.page_info || {};
    var key = ctx && typeof ctx.after === 'string' ? ctx.after : '';
    feed.pages[source][key] = { items: items, end: info.end_cursor || null, more: !!info.has_next_page };
    feed.version++;
  }

  function scan(text, ctx) {
    if (!text || (text.indexOf('is_private') === -1 && text.indexOf('timeline__connection') === -1)) return;
    // Some responses are several JSON documents in a row, or start with "for (;;);".
    var parts = text.replace(/^for \(;;\);/, '').split(/\n(?=\{)/);
    for (var i = 0; i < parts.length; i++) {
      try { walk(JSON.parse(parts[i]), 0, ctx); } catch (e) {}
    }
  }

  /* ---------- 3. Requests ---------- */
  var SESSION_FIELDS = ['av', '__d', '__user', '__a', '__hs', 'dpr', '__ccg', '__rev', '__s', '__hsi', '__dyn',
    '__csr', '__hsdp', '__hblp', '__sjsp', '__comet_req', 'fb_dtsg', 'jazoest', 'lsd', '__spin_r', '__spin_b',
    '__spin_t', '__crn'];

  function headersObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) { h.forEach(function (v, k) { out[k.toLowerCase()] = v; }); return out; }
    if (Array.isArray(h)) { h.forEach(function (p) { out[String(p[0]).toLowerCase()] = p[1]; }); return out; }
    for (var k in h) out[k.toLowerCase()] = h[k];
    return out;
  }

  // Looks at one outgoing request. Returns the context its response should be read with.
  function inspect(url, body, headers) {
    var ctx = { after: '' };
    if (typeof body !== 'string' || String(url).indexOf('graphql') === -1) return ctx;
    var p;
    try { p = new URLSearchParams(body); } catch (e) { return ctx; }
    if (p.get('fb_dtsg')) {
      var common = {};
      SESSION_FIELDS.forEach(function (f) { if (p.has(f)) common[f] = p.get(f); });
      feed.common = common;
    }
    var vars = null;
    try { vars = JSON.parse(p.get('variables') || 'null'); } catch (e) {}
    // Instagram's like and unlike requests: keep their current id and headers, so the Friends
    // feed's heart sends exactly what Instagram's own button sends (extras.js, section 7).
    var fname = p.get('fb_api_req_friendly_name') || '';
    var likeKind = /LikeMediaXIGLikeMutation$/.test(fname) ? 'like' : /LikeMediaXIGUnlikeMutation$/.test(fname) ? 'unlike' : '';
    if (likeKind && p.get('doc_id')) {
      var hs = headersObject(headers);
      delete hs['x-csrftoken']; delete hs['x-fb-lsd']; delete hs['x-fb-entry-nonce'];
      try { localStorage.setItem('following.likeTpl.' + likeKind, JSON.stringify({ name: fname, doc: p.get('doc_id'), url: String(url), headers: hs, caller: p.get('fb_api_caller_class') || 'RelayModern' })); } catch (e) {}
    }
    if (vars && p.get('doc_id') && (vars.variant === 'home' || (vars.data && vars.data.pagination_source === 'following'))) {
      ctx.after = typeof vars.after === 'string' ? vars.after : '';
      ctx.source = vars.variant === 'home' ? 'home' : 'following';
      // Learn the request from Instagram's own Following "load more" (the Friends feed's own
      // ranked requests are built from it, so they are not stored).
      if (ctx.source === 'following') {
        // Seen live on this page: its session fields are current (a stored one goes stale).
        feed.live = true;
        feed.template = { url: String(url), body: body, headers: headersObject(headers) };
        try { localStorage.setItem('following.feedTemplate', JSON.stringify(feed.template)); } catch (e) {}
      }
    }
    return ctx;
  }

  var origFetch = window.fetch;
  window.__flFetch = origFetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var ctx = { after: '' };
      try { ctx = inspect(url, init && init.body, init && init.headers); } catch (e) {}
      var p = origFetch.apply(this, arguments);
      p.then(function (res) {
        try {
          var type = res.headers.get('content-type') || '';
          if (type.indexOf('json') !== -1 || type.indexOf('javascript') !== -1 || type.indexOf('text') !== -1) {
            res.clone().text().then(function (t) { scan(t, ctx); }).catch(function () {});
          }
        } catch (e) {}
      }).catch(function () {});
      return p;
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__flUrl = url;
    this.__flHeaders = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try { this.__flHeaders[String(k).toLowerCase()] = v; } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var ctx = { after: '' };
    try { ctx = inspect(xhr.__flUrl, body, xhr.__flHeaders); } catch (e) {}
    this.addEventListener('load', function () {
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') scan(xhr.responseText, ctx);
        else if (xhr.responseType === 'json') walk(xhr.response, 0, ctx);
      } catch (e) {}
    });
    return origSend.apply(this, arguments);
  };

  // The first page, built into the HTML.
  document.addEventListener('DOMContentLoaded', function () {
    var scripts = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < scripts.length; i++) scan(scripts[i].textContent, { after: '', source: location.search.indexOf('variant=following') !== -1 ? 'following' : 'home' });
  });
})();
