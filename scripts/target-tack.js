// Which tack a camera target is on, from how it moves across the picture over a few seconds.
// A boat of the same fleet on our tack sails about our course and speed, so its bearing from us hardly changes.
// On the other tack it sails our course mirrored on the wind (TWA 42 -> 84 degrees apart): seen from us it slides
// across the wind at about 2 x speed x sin(TWA), some 5 m/s at 7.4 kn upwind. Heel, sails and boom are always to
// leeward on either tack, so the picture alone does not tell; the motion does.
//
// Two motions are used: sideways, from the bearings (precise), and along the line of sight, from the distance
// (mast height in pixels, noisier). Seen across the wind the other tack shows mostly as closing or opening.
//
//   targetTack(pts, own) -> {tack: "port"|"stbd"|null, same, conf, sep, rate, range, expectOther, se}
//     pts: [{t: seconds, brg: true degrees, dist: metres}] of one target, oldest first
//     own: {cog, sog (knots), twd} at the time
//   tack null = cannot tell yet (too short, too noisy, or seen where both tacks move alike)
(function (root) {
  "use strict";
  var D2R = Math.PI / 180, KN = 1852 / 3600;
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }
  function median(a) { var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }

  function targetTack(pts, own) {
    var none = { tack: null, same: null, conf: 0 };
    if (!pts || pts.length < 4 || !own || !isFinite(own.cog) || !isFinite(own.twd) || !(own.sog > 0)) return none;
    var span = pts[pts.length - 1].t - pts[0].t;
    if (span < 1.5) return none;
    var ourTack = wrap180(own.twd - own.cog) < 0 ? "port" : "stbd", other = ourTack === "port" ? "stbd" : "port";
    // mean bearing and distance
    var sx = 0, sy = 0;
    pts.forEach(function (p) { sx += Math.sin(p.brg * D2R); sy += Math.cos(p.brg * D2R); });
    var bm = Math.atan2(sx, sy) / D2R, dm = median(pts.map(function (p) { return p.dist; }));
    // two rates from the track: sideways (from the bearings, + = toward bearing + 90) and along the line of sight
    // (from the distances, + = going away). Each with its standard error, never below the sensors' own noise:
    // half a degree of bearing, 8% of distance.
    function fit(vals, floor) {
      var n = vals.length, mt = 0, mx = 0, stt = 0, stx = 0, ss = 0;
      vals.forEach(function (q) { mt += q.t / n; mx += q.x / n; });
      vals.forEach(function (q) { stt += (q.t - mt) * (q.t - mt); stx += (q.t - mt) * (q.x - mx); });
      var rate = stx / stt;
      vals.forEach(function (q) { var r = q.x - (mx + rate * (q.t - mt)); ss += r * r; });
      return { rate: rate, se: Math.max(Math.sqrt(ss / Math.max(1, n - 2) / stt), floor / span) };
    }
    var lat = fit(pts.map(function (p) { return { t: p.t, x: dm * Math.sin(wrap180(p.brg - bm) * D2R) }; }), dm * 0.5 * D2R);
    var rad = fit(pts.map(function (p) { return { t: p.t, x: p.dist }; }), dm * 0.08);
    // what the other tack would show: (its velocity - ours), across and along the line of sight; our tack shows ~0
    var v = own.sog * KN, oc = 2 * own.twd - own.cog;
    var dv = [v * (Math.sin(oc * D2R) - Math.sin(own.cog * D2R)), v * (Math.cos(oc * D2R) - Math.cos(own.cog * D2R))];
    var eLat = dv[0] * Math.cos(bm * D2R) - dv[1] * Math.sin(bm * D2R), eRad = dv[0] * Math.sin(bm * D2R) + dv[1] * Math.cos(bm * D2R);
    var chi = function (a, b) { return Math.pow((lat.rate - a) / lat.se, 2) + Math.pow((rad.rate - b) / rad.se, 2); };
    // how far apart the two answers are, in standard errors: below 3 the geometry cannot tell them
    var sep = Math.sqrt(Math.pow(eLat / lat.se, 2) + Math.pow(eRad / rad.se, 2));
    var cSame = chi(0, 0), cOther = chi(eLat, eRad), same = cSame < cOther;
    var conf = Math.sqrt(Math.abs(cOther - cSame));
    var out = { same: same, conf: conf, sep: sep, rate: lat.rate, range: rad.rate, expectOther: [eLat, eRad], se: [lat.se, rad.se] };
    // and if it fits neither (another class, a boat tacking, a bad track), say so rather than pick one
    out.tack = sep >= 3 && conf >= 2 && Math.min(cSame, cOther) < 9 ? (same ? ourTack : other) : null;
    return out;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { targetTack: targetTack };
  else root.targetTack = targetTack;
})(this);
