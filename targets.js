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

  var cfg = { mast: load("mast", 16), fov: load("fov", 67), align: load("align", 0), aligned: load("aligned", false), markH: load("markH", 2) };
  var st = { on: false, model: null, stream: null, az: NaN, azAt: 0, azSrc: "", tracks: [], nextId: 1, last: [], ms: 0, fps: 0, hz: NaN, zoom: 1, cands: [], marks: load("marks", []), sel: null, frameW: 0, frameH: 0 };
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
    "#tgView .set input{width:70px;font-size:17px;margin-left:6px}#tgView .set p{margin:0;font-size:14px;color:#ccc}" +
    "#tgView video{transform-origin:50% 50%}" +
    "#tgView .mk{position:absolute;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom) + 44px);background:#000c;border:1px solid #f5b400;border-radius:12px;padding:10px 12px;display:grid;grid-template-columns:1fr auto auto;gap:6px 8px;align-items:center;font-size:16px}" +
    "#tgView .mk b{font-size:20px;color:#f5b400}#tgView .mk small{grid-column:1 / -1;color:#ddd;font-size:14px}#tgView .mk button.go{background:#f5b400;color:#000;border-color:#f5b400}";
  function build() {
    if ($("tgView")) return;
    var s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    var v = document.createElement("div"); v.id = "tgView"; v.hidden = true;
    v.innerHTML = '<video id="tgVid" playsinline muted autoplay></video><canvas id="tgCv"></canvas>' +
      '<div class="bar"><button id="tgClose" aria-label="Close Targets">✕</button><button id="tgAlign">Align</button><button id="tgSet">⚙︎</button><button id="tgZoom" aria-label="Zoom">1×</button>' +
      '<div class="read"><div>CAM <b id="tgAz">---</b></div><div id="tgInfo"></div></div></div>' +
      '<div class="set" id="tgSetBox" hidden><label>Mast height above water, m<input id="tgMast" type="number" step="0.5"></label>' +
      '<label>Camera field of view (long side), °<input id="tgFov" type="number" step="0.5"></label>' +
      '<label>Mark height above water, m<input id="tgMarkH" type="number" step="0.1"></label>' +
      '<p>Align: hold the phone pointing at the bow, along the boat, and tap Align. It takes the boat heading as where the camera points.</p></div>' +
      '<div class="mk" id="tgMk" hidden></div><div class="msg" id="tgMsg"></div>';
    document.body.appendChild(v);
    $("tgClose").onclick = close;
    $("tgSet").onclick = function () { $("tgSetBox").hidden = !$("tgSetBox").hidden; };
    $("tgMast").value = cfg.mast; $("tgFov").value = cfg.fov;
    $("tgMast").onchange = function () { var x = +this.value; if (x > 2 && x < 60) { cfg.mast = x; save("mast", x); } };
    $("tgFov").onchange = function () { var x = +this.value; if (x > 20 && x < 130) { cfg.fov = x; save("fov", x); } };
    $("tgAlign").onclick = alignNow;
    $("tgMarkH").value = cfg.markH;
    $("tgMarkH").onchange = function () { var x = +this.value; if (x > 0.2 && x < 20) { cfg.markH = x; save("markH", x); } };
    // digital zoom: the middle of the picture, enlarged on screen and for the detectors (bearings stay exact)
    $("tgZoom").onclick = function () { st.zoom = st.zoom >= 3 ? 1 : st.zoom + 1; this.textContent = st.zoom + "×"; $("tgVid").style.transform = "scale(" + st.zoom + ")"; };
    $("tgCv").addEventListener("pointerdown", tap);
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
    var z = st.zoom, sw = W / z, sh = H / z;
    cx.drawImage(vid, (W - sw) / 2, (H - sh) / 2, sw, sh, 0, 0, W, H);
    st.frameW = W; st.frameH = H;
    return detect(W, H).then(function (dets) {
      st.ms = performance.now() - t0; st.fps = st.fps ? st.fps * 0.8 + 200 / Math.max(1, st.ms) : 1000 / Math.max(1, st.ms);
      var f = focal(W, H), own = ownNow();
      // marks first: a small far shape that is all orange or yellow is a buoy, not a boat
      st.cands = markBlobs(W, H, st.hz, f, cam);
      dets = dets.filter(function (d) { return !((d.far || d.small) && st.cands.some(function (c) { return overlap(c.box, d.box).cont > 0.5; })); });
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
      followMarks(t, cam, f, own);
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

  // ---------- course marks: found by colour, picked with a tap, placed from two or more bearings ----------
  // focal length in pixels of the analysed frame: the zoom narrows the field of view
  function focal(W, H) { return st.zoom * (Math.max(W, H) / 2) / Math.tan(cfg.fov / 2 * D2R); }
  // race marks are orange, yellow or red and sit on the sea line: saturated warm blobs in a strip along the horizon
  function markBlobs(W, H, hz, f, cam) {
    if (!fin(hz)) return [];
    var u = Math.max(W, H) / 1920, k = 2, y0 = Math.max(0, Math.round(hz - 70 * u)), y1 = Math.min(H, Math.round(hz + 30 * u));
    var w = Math.floor(W / k), h = Math.floor((y1 - y0) / k); if (h < 3) return [];
    var d = cx.getImageData(0, y0, W, y1 - y0).data, mask = new Uint8Array(w * h), x, y;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var i = ((y * k) * W + x * k) * 4, r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 110 || (mx - mn) / mx < 0.5 || b > g || r < g * 0.95) continue;        // warm: red >= green > blue, bright, saturated
      var hue = mx === r ? 60 * (g - b) / (mx - mn) : 999;
      if (hue >= 0 && hue <= 62) mask[y * w + x] = 1;
    }
    var lab = new Int32Array(w * h), out = [], n = 0;
    for (var j = 0; j < w * h; j++) {
      if (!mask[j] || lab[j]) continue;
      n++; var stk = [j], ax = 1e9, bx = -1, ay = 1e9, by = -1, cnt = 0; lab[j] = n;
      while (stk.length) {
        var q = stk.pop(), qx = q % w, qy = (q / w) | 0; cnt++;
        if (qx < ax) ax = qx; if (qx > bx) bx = qx; if (qy < ay) ay = qy; if (qy > by) by = qy;
        var nb = [q - 1, q + 1, q - w, q + w];
        for (var m = 0; m < 4; m++) { var r2 = nb[m]; if (r2 < 0 || r2 >= w * h || Math.abs((r2 % w) - qx) > 1) continue; if (mask[r2] && !lab[r2]) { lab[r2] = n; stk.push(r2); } }
      }
      var bw = (bx - ax + 1) * k, bh = (by - ay + 1) * k;
      if (cnt < 2 || bw > 80 * u || bh > 80 * u || bw > bh * 3 + 4) continue;
      var box = [ax * k, y0 + ay * k, bw, bh], ang = Math.atan((box[0] + bw / 2 - W / 2) / f) * R2D;
      out.push({ box: box, ang: ang, brg: fin(cam) ? wrap360(cam + ang) : NaN });
    }
    return out.slice(0, 12);
  }
  // marks kept from an earlier session go on being followed from their last bearing
  st.marks.forEach(function (M) { var L = M.sight && M.sight[M.sight.length - 1]; M.sight = M.sight || []; M.brg = L ? L.brg : NaN; });
  function persistMarks() { save("marks", st.marks.map(function (M) { return { id: M.id, n: M.n, sight: M.sight, fix: M.fix, courseId: M.courseId }; })); }
  // each followed mark: the nearest warm blob within a few degrees of where it was; a new bearing every 25 m we sail
  function followMarks(t, cam, f, own) {
    var S = window.MRT.own();
    st.marks.forEach(function (M) {
      if (!fin(cam) || !fin(M.brg)) return;
      var best = null, bd = 3;
      st.cands.forEach(function (c) { var da = Math.abs(wrap180(c.brg - M.brg)); if (da < bd) { bd = da; best = c; } });
      if (!best) return;
      M.box = best.box; M.seen = t; M.brg = wrap360(M.brg + wrap180(best.brg - M.brg) * 0.5);
      M.hdist = cfg.markH * f / Math.max(2, best.box[3]);
      if (fin(S.lat) && fin(S.lon)) {
        var L = M.sight[M.sight.length - 1];
        if (!L || distM(L.lat, L.lon, S.lat, S.lon) > 25 || t - L.t > 30) { M.sight.push({ t: t, brg: Math.round(M.brg * 10) / 10, lat: S.lat, lon: S.lon }); M.sight = M.sight.slice(-30); fixMark(M); persistMarks(); }
      }
    });
    if (st.sel) markBar();
  }
  function distM(a1, o1, a2, o2) { var dy = (a2 - a1) * 111120, dx = (o2 - o1) * 111120 * Math.cos(a1 * D2R); return Math.hypot(dx, dy); }
  // the mark where the bearing lines cross (least squares over all of them); needs lines at least 8 degrees apart
  // the mark where the bearing lines cross; a bearing that does not agree with the others by more than 6 degrees
  // (another buoy for a moment, a compass jump) is left out, the worst first, as long as two remain
  function fixMark(M) {
    var use = M.sight.slice();
    for (;;) {
      var f = crossing(use);
      if (f && f.worst.res <= 6) { M.fix = f.fix; M.spread = f.spread; M.dropped = M.sight.length - use.length; break; }
      if (use.length <= 2) { M.fix = null; M.spread = f ? f.spread : spreadOf(use); break; }
      var k = f ? f.worst.i : worstAgainstRest(use);
      use.splice(k, 1);
    }
    if (M.fix && M.courseId) window.MRT.moveMark(M.courseId, M.fix.lat, M.fix.lon);
  }
  function spreadOf(P) { var lo = 1e9, hi = -1e9; P.forEach(function (p) { var r = wrap180(p.brg - P[0].brg); if (r < lo) lo = r; if (r > hi) hi = r; }); return P.length ? hi - lo : 0; }
  // without a crossing, the bearing farthest from the median direction goes first
  function worstAgainstRest(P) {
    var med = median(P.map(function (p) { return wrap180(p.brg - P[0].brg); })), wi = 0, wd = -1;
    P.forEach(function (p, i) { var d = Math.abs(wrap180(p.brg - P[0].brg) - med); if (d > wd) { wd = d; wi = i; } });
    return wi;
  }
  function crossing(P) {
    if (P.length < 2) return null;
    var lat0 = P[0].lat, lon0 = P[0].lon, kx = 111120 * Math.cos(lat0 * D2R), ky = 111120;
    var a = 0, b = 0, c = 0, e1 = 0, e2 = 0, spread = spreadOf(P);
    P.forEach(function (p) {
      var x = (p.lon - lon0) * kx, y = (p.lat - lat0) * ky, nx = Math.cos(p.brg * D2R), ny = -Math.sin(p.brg * D2R);
      a += nx * nx; b += nx * ny; c += ny * ny; var dd = nx * x + ny * y; e1 += nx * dd; e2 += ny * dd;
    });
    var det = a * c - b * b;
    if (spread < 8) return { fix: null, spread: spread, worst: { res: 0, i: 0 } };      // lines too parallel yet: keep sailing
    if (Math.abs(det) < 1e-6) return null;
    var X = (c * e1 - b * e2) / det, Y = (a * e2 - b * e1) / det, worst = { res: -1, i: 0 };
    // how far each bearing is from pointing at the crossing (a mark behind a line counts as 180 degrees off)
    P.forEach(function (p, i) {
      var x = (p.lon - lon0) * kx, y = (p.lat - lat0) * ky, to = Math.atan2(X - x, Y - y) * R2D, r = Math.abs(wrap180(to - p.brg));
      if (r > worst.res) worst = { res: r, i: i };
    });
    var L = P[P.length - 1], dist = Math.hypot(X - (L.lon - lon0) * kx, Y - (L.lat - lat0) * ky);
    return { spread: spread, worst: worst, fix: { lat: lat0 + Y / ky, lon: lon0 + X / kx, n: P.length,
      err: Math.round(dist * Math.sin(1.5 * D2R) / Math.sin(Math.min(90, spread) * D2R) * Math.sqrt(2 / P.length)) } };   // 1.5 deg per bearing, better with more
  }
  // a tap on the picture: on a mark already followed, select it; on a blob or anywhere near the horizon, a new mark
  function tap(e) {
    var c = $("tgCv"), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    var vw = st.frameW, vh = st.frameH; if (!vw) return;
    var cw = c.width, ch = c.height, s = Math.max(cw / vw, ch / vh);
    var px = ((e.clientX - r.left) * dpr - cw / 2) / s + vw / 2, py = ((e.clientY - r.top) * dpr - ch / 2) / s + vh / 2;
    var near = function (b, tol) { return px > b[0] - tol && px < b[0] + b[2] + tol && py > b[1] - tol && py < b[1] + b[3] + tol; };
    var tol = 30 * dpr / s;
    var hit = st.marks.filter(function (M) { return M.box && st.on && near(M.box, tol); })[0];
    if (hit) { st.sel = hit.id; markBar(); return; }
    var cam = camAz(); if (!fin(cam)) { msg("No compass yet: a mark needs a bearing."); return; }
    var f = focal(vw, vh), blob = st.cands.filter(function (b) { return near(b.box, tol); })[0];
    var box = blob ? blob.box : [px - 6, py - 6, 12, 12], ang = Math.atan((box[0] + box[2] / 2 - vw / 2) / f) * R2D;
    var n = 1; while (st.marks.some(function (M) { return M.n === "B" + n; })) n++;
    var M = { id: "k" + Date.now().toString(36), n: "B" + n, brg: wrap360(cam + ang), box: box, seen: Date.now() / 1000, sight: [] };
    var S = window.MRT.own();
    if (fin(S.lat)) M.sight.push({ t: M.seen, brg: Math.round(M.brg * 10) / 10, lat: S.lat, lon: S.lon });
    st.marks.push(M); st.sel = M.id; persistMarks(); markBar();
  }
  function markBar() {
    var el = $("tgMk"), M = st.marks.filter(function (x) { return x.id === st.sel; })[0];
    if (!M) { el.hidden = true; return; }
    var S = window.MRT.own(), d, info;
    if (M.fix && fin(S.lat)) {
      d = distM(S.lat, S.lon, M.fix.lat, M.fix.lon);
      var by = Math.atan2((M.fix.lon - S.lon) * Math.cos(S.lat * D2R), M.fix.lat - S.lat) * R2D;
      info = Math.round(d) + " m · " + ("00" + Math.round(wrap360(by))).slice(-3) + "° · placed ±" + M.fix.err + " m from " + M.fix.n + " bearings";
    } else {
      info = (fin(M.brg) ? ("00" + Math.round(M.brg)).slice(-3) + "°" : "") + (fin(M.hdist) ? " · ~" + Math.round(M.hdist / 10) * 10 + " m" : "") +
        " · " + (M.sight.length < 2 ? "sail on 150–300 m with it in view to place it" : "keep it in view, the bearings must open up (" + Math.round(M.spread || 0) + "° of 8°)");
    }
    var h = "<b>" + M.n + "</b>" + (M.fix ? '<button class="go" id="tgMkUse">' + (M.courseId ? "In course ✓" : "Use as mark") + "</button>" : "<span></span>") +
      '<button id="tgMkDel">Delete</button><small>' + info + "</small>";
    if (el.innerHTML !== h) {
      el.innerHTML = h; el.hidden = false;
      if ($("tgMkUse")) $("tgMkUse").onclick = function () {
        if (!M.courseId && M.fix) { M.courseId = window.MRT.addMark(M.n, M.fix.lat, M.fix.lon); persistMarks(); msg(M.n + " is in Course and marks, and on the map."); markBar(); }
      };
      $("tgMkDel").onclick = function () { st.marks = st.marks.filter(function (x) { return x.id !== M.id; }); st.sel = null; persistMarks(); markBar(); };
    }
  }
  function drawMarks(g, ox, oy, s, dpr) {
    g.setLineDash([4 * dpr, 4 * dpr]); g.strokeStyle = "#f5b40099"; g.lineWidth = 2 * dpr;
    st.cands.forEach(function (c) {
      if (st.marks.some(function (M) { return M.box === c.box; })) return;
      var b = c.box; g.beginPath(); g.arc(ox + (b[0] + b[2] / 2) * s, oy + (b[1] + b[3] / 2) * s, Math.max(10 * dpr, b[3] * s), 0, 7); g.stroke();
    });
    g.setLineDash([]);
    var t = Date.now() / 1000;
    st.marks.forEach(function (M) {
      if (!M.box || t - (M.seen || 0) > 3) return;
      var b = M.box, x = ox + (b[0] + b[2] / 2) * s, y = oy + (b[1] + b[3] / 2) * s, R = Math.max(14 * dpr, b[3] * s * 0.8);
      g.strokeStyle = "#f5b400"; g.lineWidth = (M.id === st.sel ? 4 : 2.5) * dpr;
      g.beginPath(); g.moveTo(x, y - R); g.lineTo(x + R, y); g.lineTo(x, y + R); g.lineTo(x - R, y); g.closePath(); g.stroke();
      g.textAlign = "center"; g.shadowColor = "#000"; g.shadowBlur = 4 * dpr; g.fillStyle = "#f5b400"; g.font = "700 " + 18 * dpr + "px 'Barlow Condensed',sans-serif";
      g.fillText(M.n + (M.fix ? " ✓" : " · " + M.sight.length), x, y - R - 6 * dpr); g.shadowBlur = 0;
    });
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
      var f = focal(vw, vh);
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
    drawMarks(g, ox, oy, s, dpr);
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
  window.MRTargets = { open: open, close: close, st: st, fixMark: fixMark };
})();
