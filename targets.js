// MaxRace Targets: point the phone at the fleet and every boat in the picture becomes a target with its distance,
// bearing, lead on the wind ladder (+ green: we are ahead) and, after a few seconds, its tack. The targets go to the
// Map and Dash+Map views (and, when the page comes from the MaxRace server, to every screen on the boat).
//
//   distance = mast height x focal length / height of the boat in the picture (pinhole camera)
//   bearing  = where the camera points (phone compass + Align) + angle of the boat from the picture centre
//   lead     = distance along TWD: upwind the boat further upwind is ahead, downwind the one further downwind
//   tack     = from how the boat moves against us over a few seconds (scripts/target-tack.js)
//
// The page gives: window.MRT = {own() -> S, targets(j), nat(o), native}. The boat detector (TensorFlow.js, COCO-SSD)
// is loaded from vendor/ only when Targets opens, so the dashboard stays light.
(function () {
  "use strict";
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function $(id) { return document.getElementById(id); }
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }
  function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }
  function load(k, d) { try { var v = localStorage.getItem("mrt." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem("mrt." + k, JSON.stringify(v)); } catch (e) {} }

  var cfg = { mast: load("mast", 16), fov: load("fov", 67), align: load("align", 0), aligned: load("aligned", false) };
  var st = { on: false, model: null, stream: null, az: NaN, azAt: 0, azSrc: "", tracks: [], nextId: 1, last: [], ms: 0, fps: 0, hz: NaN };
  var cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });

  // ---------- the view ----------
  var css = "#tgView{position:fixed;inset:0;z-index:50;background:#000;color:#fff;font-family:'Barlow Condensed','Barlow',system-ui,sans-serif}" +
    "#tgView video,#tgView canvas{position:absolute;inset:0;width:100%;height:100%}#tgView video{object-fit:cover}" +
    "#tgView .bar{position:absolute;left:0;right:0;top:0;display:flex;gap:8px;align-items:center;padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;background:linear-gradient(#000c,#0000)}" +
    "#tgView button{font:600 17px 'Barlow Condensed',system-ui,sans-serif;color:#fff;background:#ffffff26;border:1px solid #fff5;border-radius:10px;padding:8px 12px}" +
    "#tgView button.warn{background:#e8a33a;color:#000;border-color:#e8a33a}" +
    "#tgView .read{margin-left:auto;text-align:right;font-size:15px;line-height:1.15;text-shadow:0 1px 2px #000}#tgView .read b{font-size:22px}" +
    "#tgView .msg{position:absolute;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 12px);font-size:16px;text-shadow:0 1px 3px #000}" +
    "#tgView .set{position:absolute;right:12px;top:calc(env(safe-area-inset-top) + 60px);background:#000d;border:1px solid #fff4;border-radius:12px;padding:12px;font-size:16px;display:grid;gap:8px;max-width:300px}" +
    "#tgView .set input{width:70px;font-size:17px;margin-left:6px}#tgView .set p{margin:0;font-size:14px;color:#ccc}";
  function build() {
    if ($("tgView")) return;
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    var v = document.createElement("div"); v.id = "tgView"; v.hidden = true;
    v.innerHTML = '<video id="tgVid" playsinline muted autoplay></video><canvas id="tgCv"></canvas>' +
      '<div class="bar"><button id="tgClose" aria-label="Close Targets">✕</button><button id="tgAlign">Align</button><button id="tgSet">⚙︎</button>' +
      '<div class="read"><div>CAM <b id="tgAz">---</b></div><div id="tgInfo"></div></div></div>' +
      '<div class="set" id="tgSetBox" hidden><label>Mast height above water, m<input id="tgMast" type="number" step="0.5"></label>' +
      '<label>Camera field of view (long side), °<input id="tgFov" type="number" step="0.5"></label>' +
      '<p>Align: hold the phone pointing at the bow, along the boat, and tap Align. It takes the boat heading as where the camera points.</p></div>' +
      '<div class="msg" id="tgMsg"></div>';
    document.body.appendChild(v);
    $("tgClose").onclick = close;
    $("tgSet").onclick = function () { $("tgSetBox").hidden = !$("tgSetBox").hidden; };
    $("tgMast").value = cfg.mast; $("tgFov").value = cfg.fov;
    $("tgMast").onchange = function () { var x = +this.value; if (x > 2 && x < 60) { cfg.mast = x; save("mast", x); } };
    $("tgFov").onchange = function () { var x = +this.value; if (x > 20 && x < 130) { cfg.fov = x; save("fov", x); } };
    $("tgAlign").onclick = alignNow;
    showAlign();
  }
  function msg(t) { var m = $("tgMsg"); if (m) m.textContent = t || ""; }
  function showAlign() { var b = $("tgAlign"); if (b) b.className = cfg.aligned ? "" : "warn"; }

  // ---------- where the camera points ----------
  // In the app: CoreMotion on the phone (true north, sent as "camDir"). In a browser: the compass of the page.
  window.MRN = window.MRN || {};
  window.MRN.camDir = function (o) { if (o && fin(o.az)) { st.az = o.az; st.azAt = Date.now(); st.azSrc = o.ref || "true"; } };
  function onOrient(e) {
    var az = NaN;
    if (fin(e.webkitCompassHeading)) az = e.webkitCompassHeading;                // iOS Safari: where the back of the phone points
    else if (e.absolute && fin(e.alpha) && fin(e.beta) && fin(e.gamma)) {       // others: the back camera axis from the angles
      var a = e.alpha * D2R, b = e.beta * D2R, g = e.gamma * D2R;
      var east = -(Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g));
      var north = -(Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g));
      az = wrap360(Math.atan2(east, north) * R2D);
    }
    if (fin(az)) { st.az = az; st.azAt = Date.now(); st.azSrc = "mag"; }
  }
  function compassOn() {
    var M = window.MRT;
    if (M && M.native) { M.nat({ cmd: "camDir", on: true }); return Promise.resolve(); }
    var D = window.DeviceOrientationEvent, p = D && D.requestPermission ? D.requestPermission() : Promise.resolve("granted");
    return p.then(function (r) {
      if (r !== "granted") { msg("No compass: allow motion and orientation for this page."); return; }
      window.addEventListener("deviceorientationabsolute", onOrient);
      window.addEventListener("deviceorientation", onOrient);
    }).catch(function () { msg("No compass on this device."); });
  }
  function compassOff() {
    var M = window.MRT;
    if (M && M.native) M.nat({ cmd: "camDir", on: false });
    window.removeEventListener("deviceorientationabsolute", onOrient);
    window.removeEventListener("deviceorientation", onOrient);
  }
  function camAz() { return fin(st.az) && Date.now() - st.azAt < 2000 ? wrap360(st.az + cfg.align) : NaN; }
  // Align: the phone held along the boat reads X while the instruments say HDG, so align = HDG - X
  function alignNow() {
    var S = window.MRT.own(), h = fin(S.hdg) ? S.hdg : S.cog;
    if (!fin(h)) { msg("Align needs the boat heading (instruments or GPS course)."); return; }
    if (!fin(st.az)) { msg("No compass reading yet."); return; }
    cfg.align = wrap180(h - st.az); cfg.aligned = true; save("align", cfg.align); save("aligned", true); showAlign();
    msg("Aligned: camera " + Math.round(st.az) + "° = heading " + Math.round(h) + "° (offset " + (cfg.align >= 0 ? "+" : "") + cfg.align.toFixed(1) + "°).");
  }

  // ---------- the detector ----------
  function script(src) {
    return new Promise(function (ok, ko) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = function () { ko(new Error("cannot load " + src)); }; document.head.appendChild(s); });
  }
  function loadModel() {
    if (st.model) return Promise.resolve(st.model);
    msg("Loading the boat detector…");
    var p = window.cocoSsd ? Promise.resolve() : (window.tf ? Promise.resolve() : script("vendor/tf.min.js")).then(function () { return script("vendor/coco-ssd.min.js"); });
    return p.then(function () { return window.cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl: "vendor/models/ssdlite_mobilenet_v2/model.json" }); })
      .then(function (m) { st.model = m; return m; });
  }
  // the horizon: the row where bright sky turns into darker sea (fraction of the height)
  var hc = document.createElement("canvas"), hx = hc.getContext("2d", { willReadFrequently: true });
  function horizonY(src) {
    var w = 108, h = 192; hc.width = w; hc.height = h; hx.drawImage(src, 0, 0, w, h);
    var d = hx.getImageData(0, 0, w, h).data, rows = [], y, i, k, best = -1, by = -1;
    for (y = 0; y < h; y++) { var s = 0; for (i = 0; i < w; i++) { k = (y * w + i) * 4; s += d[k] + d[k + 1] + d[k + 2]; } rows.push(s / w / 3); }
    for (y = Math.round(h * 0.12); y < h * 0.88; y++) {
      var a = 0, b = 0; for (k = 1; k <= 6; k++) { a += rows[y - k]; b += rows[Math.min(h - 1, y + k)]; }
      if ((a - b) / 6 > best) { best = (a - b) / 6; by = y; }
    }
    return best > 15 ? by / h : NaN;
  }
  // far boats on the horizon, a few pixels, too small for the detector: what rises above the sea line against the sky
  function horizonBoats(W, H, hz) {
    var u = Math.max(W, H) / 1920, lum = function (d, i) { return (d[i] + d[i + 1] + d[i + 2]) / 3; };
    var ys = Math.max(0, Math.round(hz - 60 * u)), sh = Math.min(H - ys, Math.round(140 * u)); if (sh < 20) return [];
    var d0 = cx.getImageData(0, ys, W, sh).data, lines = [], x, y;
    for (x = 0; x < W; x += 3) for (y = 0; y < sh - 4; y++) { if (lum(d0, (y * W + x) * 4) < 150 && lum(d0, ((y + 3) * W + x) * 4) < 150) { lines.push(y + ys); break; } }
    if (lines.length < 20) return [];
    lines.sort(function (a, b) { return a - b; });
    var base = lines[Math.floor(lines.length * 0.75)], hh = Math.round(43 * u), y0 = base - hh - 2;
    if (y0 < 0) return [];
    var dd = cx.getImageData(0, y0, W, hh).data, mask = new Uint8Array(W * hh);
    for (y = 0; y < hh; y++) {
      var v = []; for (x = 0; x < W; x += 3) v.push(lum(dd, (y * W + x) * 4));
      v.sort(function (a, b) { return a - b; }); var sky = v[Math.floor(v.length * 0.75)];
      for (x = 0; x < W; x++) { var l = lum(dd, (y * W + x) * 4); if (sky - l > 35 || l - sky > 30) mask[y * W + x] = 1; }
    }
    var lab = new Int32Array(W * hh), out = [], n = 0, minH = Math.max(5, Math.round(9 * u)), maxW = Math.round(60 * u);
    for (var i = 0; i < W * hh; i++) {
      if (!mask[i] || lab[i]) continue;
      n++; var stk = [i], x0 = 1e9, x1 = -1, a0 = 1e9, a1 = -1, cnt = 0; lab[i] = n;
      while (stk.length) {
        var p = stk.pop(), px = p % W, py = (p / W) | 0; cnt++;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < a0) a0 = py; if (py > a1) a1 = py;
        var nb = [p - 1, p + 1, p - W, p + W];
        for (var q = 0; q < 4; q++) { var r = nb[q]; if (r < 0 || r >= W * hh || Math.abs((r % W) - px) > 1) continue; if (mask[r] && !lab[r]) { lab[r] = n; stk.push(r); } }
      }
      if (a0 > 1 && a1 + y0 >= base - 6 * u && x1 - x0 <= maxW && cnt >= 10 * u * u && a1 - a0 >= minH && x0 > 4 && x1 < W - 5)
        out.push({ box: [x0, a0 + y0, x1 - x0 + 1, a1 - a0 + 1], score: 0.5, far: true });
    }
    return out;
  }
  function overlap(a, b) {
    var x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
    var i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return { iou: i / (a[2] * a[3] + b[2] * b[3] - i), cont: i / Math.min(a[2] * a[3], b[2] * b[3]) };
  }
  // a square piece of the picture, enlarged for the detector: small boats along the horizon become visible to it
  var tc = document.createElement("canvas"), tcx = tc.getContext("2d"), tileK = 0;
  function detectTile(sx, sy, sz, W, H) {
    var n = Math.min(sz, 640); tc.width = tc.height = n;
    tcx.drawImage(cv, sx, sy, sz, sz, 0, 0, n, n);
    var k = sz / n;
    return st.model.detect(tc, 20, 0.15).then(function (res) {
      var out = [], e = 4;
      res.forEach(function (d) {
        if (d.class !== "boat") return;
        var b = [sx + d.bbox[0] * k, sy + d.bbox[1] * k, d.bbox[2] * k, d.bbox[3] * k];
        // cut by an inner tile edge: only part of a boat
        if ((b[0] < sx + e && sx > 0) || (b[0] + b[2] > sx + sz - e && sx + sz < W)) return;
        out.push({ box: b, score: d.score, small: true });
      });
      return out;
    });
  }
  function detect(W, H) {
    var u = Math.max(W, H) / 1920, hz = horizonY(cv) * H; st.hz = hz;
    var jobs = [st.model.detect(cv, 20, 0.2).then(function (res) {
      return res.filter(function (d) { return d.class === "boat"; }).map(function (d) { return { box: d.bbox, score: d.score }; });
    })];
    // one tile along the horizon per frame, in turn: every boat on it is looked at a few times a second
    if (fin(hz)) {
      var sz = Math.round(Math.min(W, H) / 2), y = Math.max(0, Math.min(H - sz, Math.round(hz - sz * 0.7))), xs = [];
      for (var x = 0; x + sz <= W; x += sz / 2) xs.push(Math.round(x));
      if ((W - sz) % (sz / 2)) xs.push(W - sz);
      tileK = (tileK + 1) % xs.length;
      jobs.push(detectTile(xs[tileK], y, sz, W, H));
    }
    return Promise.all(jobs).then(function (r) {
      var all = r[0].concat(r[1] || []);
      if (fin(hz)) all = all.concat(horizonBoats(W, H, hz));
      var keep = all.filter(function (d) {
        var y = d.box[1], w = d.box[2], h = d.box[3], bottom = y + h;
        // far boats: sitting on the sea line (hull at it, sails above), nothing far below it in the water
        if (d.far || d.small) {
          if (!fin(hz)) return false;
          if (d.far || h < 70 * u) return bottom > hz - 8 * u && bottom < hz + 25 * u && h >= 6 * u;
        }
        // nearer boats: taller than wide, standing on the horizon; not our own deck, rails or wide shapes
        if (bottom > H * 0.85 || w * h > W * H * 0.25 || h < w * 0.9) return false;
        if (fin(hz) && ((hz - y) / h < 0.4 || bottom > hz + H * 0.12)) return false;
        return true;
      }).sort(function (a, b) { return b.score - a.score; });
      var out = [], area = function (b) { return b[2] * b[3]; };
      keep.forEach(function (d) {
        if (!out.some(function (o) { var v = overlap(o.box, d.box), r = Math.max(area(o.box), area(d.box)) / Math.min(area(o.box), area(d.box)); return v.iou > 0.3 || (v.cont > 0.6 && r < 3); })) out.push(d);
      });
      return out;
    });
  }

  // ---------- targets: measure, follow from frame to frame, tack, lead ----------
  function ownNow() {
    var S = window.MRT.own();
    return { hdg: S.hdg, cog: fin(S.cog) ? S.cog : S.hdg, sog: fin(S.sog) ? S.sog : S.bsp, twd: S.twd, twa: S.twa };
  }
  function leadOf(brg, dist, own) {
    if (!fin(own.twd)) return NaN;
    var up = dist * Math.cos((brg - own.twd) * D2R);                              // + = the target is upwind of us
    return fin(own.twa) && Math.abs(own.twa) > 90 ? up : -up;                     // + = we are ahead
  }
  function step() {
    var vid = $("tgVid"), W = vid.videoWidth, H = vid.videoHeight;
    if (!W || !H) return Promise.resolve();
    var cam = camAz(), t0 = performance.now(), t = Date.now() / 1000;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    cx.drawImage(vid, 0, 0, W, H);
    return detect(W, H).then(function (dets) {
      st.ms = performance.now() - t0; st.fps = st.fps ? st.fps * 0.8 + 200 / Math.max(1, st.ms) : 1000 / Math.max(1, st.ms);
      var f = (Math.max(W, H) / 2) / Math.tan(cfg.fov / 2 * D2R), own = ownNow();
      var meas = dets.map(function (d) {
        var b = d.box, ang = Math.atan((b[0] + b[2] / 2 - W / 2) / f) * R2D;
        return { box: b, far: d.far, ang: ang, dist: cfg.mast * f / b[3], brg: fin(cam) ? wrap360(cam + ang) : NaN };
      });
      // link to the tracks: the same boat is close in bearing (or in the picture, while there is no compass) and size
      var used = {};
      meas.forEach(function (m) {
        var best = null, bd = 1e9;
        st.tracks.forEach(function (T) {
          if (used[T.id] || t - T.seen > 3) return;
          var da = fin(m.brg) && fin(T.brg) ? Math.abs(wrap180(m.brg - T.brg)) : Math.abs(m.ang - T.ang);
          var dr = Math.max(m.dist, T.dist) / Math.min(m.dist, T.dist);
          if (da < 4 && dr < 1.7 && da + 3 * (dr - 1) < bd) { bd = da + 3 * (dr - 1); best = T; }
        });
        if (!best) { best = { id: st.nextId++, pts: [], tack: null, tackConf: 0 }; st.tracks.push(best); }
        used[best.id] = true;
        best.seen = t; best.hits = (best.hits || 0) + 1; best.box = m.box; best.ang = m.ang; best.far = m.far;
        best.pts.push({ t: t, brg: m.brg, dist: m.dist });
        best.pts = best.pts.filter(function (p) { return t - p.t <= 8; });
        // damping: the box height wobbles by a few pixels from frame to frame (waves, heel, the detector), so the
        // distance is the median of the last second, then eased in with a time constant of about 1.5 s; the bearing too
        var rd = best.pts.filter(function (p) { return t - p.t <= 1.2; });
        var dm = median(rd.map(function (p) { return p.dist; })), dt = best.tPrev ? Math.min(2, t - best.tPrev) : 0, a = dt ? 1 - Math.exp(-dt / 1.5) : 1;
        best.tPrev = t;
        best.dist = fin(best.dist) && a < 1 ? best.dist + (dm - best.dist) * a : dm;
        if (fin(m.brg)) best.brg = fin(best.brg) && a < 1 ? wrap360(best.brg + wrap180(m.brg - best.brg) * Math.min(1, a * 2)) : m.brg;
        else best.brg = NaN;
        best.lead = fin(best.brg) ? leadOf(best.brg, best.dist, own) : NaN;
        // the tack, once the boat has been followed a few seconds; it stays until the motion says otherwise
        if (window.targetTack && fin(own.cog) && fin(own.twd) && own.sog > 1) {
          var tk = window.targetTack(best.pts.filter(function (p) { return fin(p.brg); }), own);
          if (tk.tack && tk.conf >= (best.tack && tk.tack !== best.tack ? 3 : 2)) { best.tack = tk.tack; best.tackConf = tk.conf; }
        }
      });
      st.tracks = st.tracks.filter(function (T) { return t - T.seen < 30; });
      st.last = st.tracks.filter(function (T) { return T.hits >= 3 && t - T.seen < 1.2; });
      publish(t);
    });
  }
  // the targets in view go to the map (here) and to the other screens (through the MaxRace server)
  var lastPost = 0;
  function publish(t) {
    var list = st.last.filter(function (T) { return fin(T.brg) && fin(T.dist); }).map(function (T) {
      return { id: "C" + T.id, name: "T" + T.id, brg: Math.round(T.brg * 10) / 10, dist: Math.round(T.dist), t: Math.round(T.seen * 1000), tack: T.tack || undefined, src: "camera" };
    });
    if (!list.length) return;
    var S = window.MRT.own(), j = { targets: list, own: fin(S.lat) ? { lat: S.lat, lon: S.lon } : undefined };
    window.MRT.targets(j);
    if (!window.MRT.native && /^https?:/.test(location.protocol) && t - lastPost > 1) {
      lastPost = t;
      try { fetch("/targets", { method: "POST", body: JSON.stringify(j) }).catch(function () {}); } catch (e) {}
    }
  }

  // ---------- drawing over the picture ----------
  function draw() {
    if (!st.on) return;
    requestAnimationFrame(draw);
    var c = $("tgCv"), vid = $("tgVid"), dpr = window.devicePixelRatio || 1;
    var cw = c.clientWidth * dpr, ch = c.clientHeight * dpr;
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    var g = c.getContext("2d"); g.clearRect(0, 0, cw, ch);
    var vw = vid.videoWidth, vh = vid.videoHeight; if (!vw) return;
    var s = Math.max(cw / vw, ch / vh), ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;   // object-fit: cover
    var cam = camAz();
    $("tgAz").textContent = fin(cam) ? ("00" + Math.round(cam)).slice(-3) + "°" : "---";
    var own = ownNow();
    $("tgInfo").textContent = (fin(own.twd) ? "TWD " + Math.round(own.twd) + "° · " : "no TWD · ") + st.last.length + " target" + (st.last.length === 1 ? "" : "s") + (st.ms ? " · " + Math.round(st.ms) + " ms" : "");
    // parity: the line through us square to TWD, where it meets the horizon in the picture (a mark on the edge)
    if (fin(cam) && fin(own.twd) && fin(st.hz)) {
      var f = (Math.max(vw, vh) / 2) / Math.tan(cfg.fov / 2 * D2R);
      [own.twd + 90, own.twd - 90].forEach(function (pb) {
        var rel = wrap180(pb - cam); if (Math.abs(rel) > 80) return;
        var x = ox + (vw / 2 + f * Math.tan(rel * D2R)) * s, y = oy + st.hz * s;
        if (x < 0 || x > cw) return;
        g.strokeStyle = "#ffffffcc"; g.lineWidth = 2 * dpr; g.setLineDash([8 * dpr, 6 * dpr]);
        g.beginPath(); g.moveTo(x, y - 60 * dpr); g.lineTo(x, y + 60 * dpr); g.stroke(); g.setLineDash([]);
        g.fillStyle = "#fff"; g.font = "600 " + 14 * dpr + "px 'Barlow Condensed',sans-serif"; g.textAlign = "center"; g.fillText("parity", x, y - 66 * dpr);
      });
    }
    if (/tgdebug/.test(location.search) && fin(st.hz)) { g.strokeStyle = "#ff0"; g.lineWidth = 1 * dpr; g.beginPath(); g.moveTo(0, oy + st.hz * s); g.lineTo(cw, oy + st.hz * s); g.stroke(); }
    st.last.forEach(function (T) {
      // the box glides to where the boat is; the numbers on screen move only for a real change (hysteresis)
      if (!T.dbox) T.dbox = T.box.slice();
      for (var i = 0; i < 4; i++) T.dbox[i] += (T.box[i] - T.dbox[i]) * 0.25;
      var b = T.dbox, x = ox + b[0] * s, y = oy + b[1] * s, w = b[2] * s, h = b[3] * s;
      T.shown = T.shown || {};
      // far away a pixel is tens of metres: there the numbers go by 10 or 50 m, not by the metre
      var hold = function (k, v, step, q) { if (!fin(v)) return v; var o = T.shown[k]; if (!fin(o) || Math.abs(v - o) >= step) T.shown[k] = Math.round(v / (q || 1)) * (q || 1); return T.shown[k]; };
      var qd = T.dist > 500 ? 50 : T.dist > 150 ? 10 : 1;
      var L = hold("lead", T.lead, Math.max(2, Math.abs(T.lead || 0) * 0.04), qd), Dd = hold("dist", T.dist, Math.max(3, T.dist * 0.04), qd), Bb = hold("brg", T.brg, 1.5);
      var col = !fin(L) ? "#8ecbff" : L >= 0 ? "#3ddc84" : "#ff5b5b";
      g.strokeStyle = col; g.lineWidth = 3 * dpr; g.strokeRect(x, y, w, h);
      var lead = !fin(L) ? "?" : Math.abs(L) < 1 ? "pari" : (L >= 0 ? "+" : "−") + Math.abs(L) + " m";
      var tk = T.tack ? (T.tack === "stbd" ? " · S" : " · P") : "";
      g.textAlign = "center"; g.shadowColor = "#000"; g.shadowBlur = 4 * dpr;
      g.fillStyle = col; g.font = "700 " + 26 * dpr + "px 'Barlow Condensed',sans-serif"; g.fillText(lead, x + w / 2, y - 26 * dpr);
      g.fillStyle = "#fff"; g.font = "600 " + 15 * dpr + "px 'Barlow Condensed',sans-serif";
      g.fillText("T" + T.id + " · " + Dd + " m" + (fin(Bb) ? " · " + ("00" + wrap360(Bb)).slice(-3) + "°" : "") + tk, x + w / 2, y - 8 * dpr);
      g.shadowBlur = 0;
    });
  }

  // ---------- open and close ----------
  function loop() {
    if (!st.on) return;
    step().catch(function (e) { msg(e.message); }).then(function () { if (st.on) setTimeout(loop, 30); });
  }
  function open() {
    build();
    $("tgView").hidden = false; st.on = true; msg("Starting the camera…");
    // for tests: ?tgsrc=video.mp4 plays a recorded video instead of the camera, ?tgaz=245 a fixed compass
    var q = new URLSearchParams(location.search), src = q.get("tgsrc"), az0 = parseFloat(q.get("tgaz"));
    if (isFinite(az0)) { st.az = az0; setInterval(function () { st.azAt = Date.now(); }, 200); }
    if (src) {
      var v0 = $("tgVid"); v0.src = src; v0.loop = true;
      Promise.all([v0.play(), loadModel()]).then(function () { msg(""); loop(); requestAnimationFrame(draw); }).catch(function (e) { msg("Targets cannot start: " + e.message); });
      return;
    }
    var cam = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      : Promise.reject(new Error("This browser gives no camera to the page (it needs https or the app)."));
    Promise.all([cam.then(function (s) { st.stream = s; var v = $("tgVid"); v.srcObject = s; return v.play(); }), compassOn()])
      .then(loadModel)
      .then(function () {
        if (!st.on) return;
        msg(cfg.aligned ? "" : "Tap Align with the phone pointing at the bow, so bearings are right.");
        loop(); requestAnimationFrame(draw);
      })
      .catch(function (e) { msg("Targets cannot start: " + e.message); });
  }
  function close() {
    st.on = false;
    if (st.stream) { st.stream.getTracks().forEach(function (k) { k.stop(); }); st.stream = null; }
    compassOff();
    var v = $("tgView"); if (v) v.hidden = true;
  }
  window.MRTargets = { open: open, close: close, st: st };
})();
