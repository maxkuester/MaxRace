// MaxRace GRIB reader: 10 m wind from GRIB1 and GRIB2 files (what Saildocs, zyGrib, NOAA/GFS and others deliver), and a wind
// field you can sample at any position and time.
//   GRIB2: grid template 3.0 (regular lat/lon); packing 5.0 (simple), 5.2 and 5.3 (complex, with spatial differencing);
//          wind as U/V (0/2/2, 0/2/3) or direction/speed (0/2/0, 0/2/1) at 10 m above ground; bitmap supported.
//   GRIB1: regular lat/lon grid; simple packing; U/V (33/34) or direction/speed (31/32) at 10 m above ground.
//   Not supported (reported in `skipped`, never guessed): JPEG2000 (5.40), PNG (5.41), CCSDS (5.42), GRIB1 second-order packing,
//          rotated or Gaussian grids, column-major scanning.
// parse(arrayBuffer) -> {fields, skipped}; buildWind(fields) -> wind; sample(wind, lat, lon, tMs) -> {tws_kn, twd_deg, u, v} | null.
// Speeds in GRIB are m/s; sample() returns knots and the direction the wind comes FROM (true). Works in the page (window.MRGrib) and Node.
(function (root) {
  "use strict";
  var KN = 1852 / 3600;
  function fin(v) { return typeof v === "number" && isFinite(v); }

  function sm(v, bytes) { var top = Math.pow(2, bytes * 8 - 1); return v >= top ? -(v - top) : v; }      // sign-and-magnitude integer
  function u(d, o, n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + d[o + i]; return v; }
  function smAt(d, o, n) { return sm(u(d, o, n), n); }
  // n bits (up to 32) at a bit offset
  function bits(d, bitOff, n) {
    if (n === 0) return 0;
    var v = 0, left = n, pos = bitOff;
    while (left > 0) {
      var byte = d[pos >> 3], avail = 8 - (pos & 7), take = Math.min(avail, left), shift = avail - take;
      v = v * Math.pow(2, take) + ((byte >> shift) & ((1 << take) - 1));
      pos += take; left -= take;
    }
    return v;
  }
  function f32(d, o) { return new DataView(d.buffer, d.byteOffset + o, 4).getFloat32(0, false); }
  function ibm32(d, o) {
    var s = d[o] & 0x80 ? -1 : 1, e = d[o] & 0x7f, m = u(d, o + 1, 3);
    return s * m / 16777216 * Math.pow(16, e - 64);
  }
  var UNIT_H = { 0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 1 / 3600 };

  // normalise the scanning: rows north to south, columns west to east
  function normalise(vals, ni, nj, scan) {
    if (scan & 0x20) throw new Error("column-major scanning");
    var out = new Float32Array(ni * nj), iRev = !!(scan & 0x80), jRev = !!(scan & 0x40);   // jRev: south to north
    for (var j = 0; j < nj; j++) for (var i = 0; i < ni; i++) {
      var si = iRev ? ni - 1 - i : i, sj = jRev ? nj - 1 - j : j;
      out[j * ni + i] = vals[sj * ni + si];
    }
    return out;
  }
  function gridOf(ni, nj, la1, lo1, la2, lo2, di, dj, scan) {
    // the first point is at (la1, lo1); the scan flags say where the others are. Work out the north-west corner.
    var north = Math.max(la1, la2), west = (scan & 0x80) ? lo2 : lo1, east = (scan & 0x80) ? lo1 : lo2;
    if (!(di > 0)) di = ni > 1 ? Math.abs(((east - west) + 720) % 360 / (ni - 1)) : 1;
    if (!(dj > 0)) dj = nj > 1 ? Math.abs(la1 - la2) / (nj - 1) : 1;
    return { ni: ni, nj: nj, lonW: west, latN: north, di: di, dj: dj };
  }

  // ---------- GRIB2 ----------
  function unpack2(rep, sec7, n, bitmap) {
    var tpl = rep.tpl, R = rep.R, E = rep.E, D = rep.D, nb = rep.nbits, out = new Float64Array(n), k, X;
    var scale = Math.pow(2, E), dec = Math.pow(10, -D);
    var m = bitmap ? bitmap.filter(Boolean).length : n;        // values present
    X = new Float64Array(m);
    if (tpl === 0) {
      for (k = 0; k < m; k++) X[k] = nb ? bits(sec7, 5 * 8 + k * nb, nb) : 0;
    } else if (tpl === 2 || tpl === 3) {
      var NG = rep.NG, off = 5 * 8, order = 0, h = [], gmin = 0;
      if (tpl === 3) {
        order = rep.order; var ob = rep.octets;
        for (k = 0; k < order; k++) { h.push(sm(u(sec7, 5 + k * ob, ob), ob)); }
        gmin = sm(u(sec7, 5 + order * ob, ob), ob);
        off = (5 + (order + 1) * ob) * 8;
      }
      var refs = [], widths = [], lens = [], g;
      for (g = 0; g < NG; g++) refs.push(bits(sec7, off + g * nb, nb)); off += NG * nb; off = Math.ceil(off / 8) * 8;
      for (g = 0; g < NG; g++) widths.push(rep.widthRef + bits(sec7, off + g * rep.widthBits, rep.widthBits)); off += NG * rep.widthBits; off = Math.ceil(off / 8) * 8;
      for (g = 0; g < NG; g++) lens.push(g === NG - 1 ? rep.lastLen : rep.lenRef + rep.lenInc * bits(sec7, off + g * rep.lenBits, rep.lenBits)); off += NG * rep.lenBits; off = Math.ceil(off / 8) * 8;
      var p = 0;
      for (g = 0; g < NG; g++) {
        var w = widths[g], L = lens[g];
        for (k = 0; k < L && p < m; k++, p++) X[p] = refs[g] + (w ? bits(sec7, off + k * w, w) : 0);
        off += L * w;
      }
      if (p < m) throw new Error("complex packing: not enough values");
      if (tpl === 3) {
        if (order === 1 || order === 2) {
          var g0 = new Float64Array(m);
          for (k = 0; k < m; k++) g0[k] = k < order ? h[k] : X[k] + gmin;
          if (order === 1) for (k = 1; k < m; k++) g0[k] = g0[k] + g0[k - 1];
          else for (k = 2; k < m; k++) g0[k] = g0[k] + 2 * g0[k - 1] - g0[k - 2];
          X = g0;
        } else throw new Error("spatial differencing order " + order);
      }
    } else throw new Error("data representation template 5." + tpl);
    var vals = new Float64Array(n), q = 0;
    for (k = 0; k < n; k++) vals[k] = bitmap ? (bitmap[k] ? (R + X[q++] * scale) * dec : NaN) : (R + X[k] * scale) * dec;
    return vals;
  }
    function parse2(d, o, skipped, out) {
    var len = u(d, o + 8, 4) * 4294967296 + u(d, o + 12, 4), end = o + len, p = o + 16, disc = d[o + 6];   // 8-byte length
    var ref = 0, grid = null, prod = null, rep = null, bitmap = null;
    while (p < end - 4) {
      var sl = u(d, p, 4), sn = d[p + 4], s = d.subarray(p, p + sl);
      if (sn === 1) ref = Date.UTC(u(s, 12, 2), s[14] - 1, s[15], s[16], s[17], s[18]);
      else if (sn === 3) {
        var tpl = u(s, 12, 2);
        if (tpl !== 0) { grid = { bad: "grid template 3." + tpl }; }
        else {
          var ni = u(s, 30, 4), nj = u(s, 34, 4), la1 = smAt(s, 46, 4) / 1e6, lo1 = smAt(s, 50, 4) / 1e6, la2 = smAt(s, 55, 4) / 1e6, lo2 = smAt(s, 59, 4) / 1e6, di = u(s, 63, 4) / 1e6, dj = u(s, 67, 4) / 1e6, scan = s[71];
          grid = { ni: ni, nj: nj, scan: scan, g: gridOf(ni, nj, la1, lo1, la2, lo2, di, dj, scan) };
        }
      } else if (sn === 4) {
        var pt = u(s, 7, 2), cat = s[9], num = s[10], fh = u(s, 18, 4) * (UNIT_H[s[17]] || NaN), st = s[22], sc = s[23], sv = u(s, 24, 4) * Math.pow(10, -(sc > 127 ? sc - 256 : sc));
        prod = { tpl: pt, cat: cat, num: num, fh: fh, level: st === 103 ? Math.round(sv * 100) / 100 : null, surface: st };
      } else if (sn === 5) {
        var rt = u(s, 9, 2);
        rep = { n: u(s, 5, 4), tpl: rt, R: f32(s, 11), E: smAt(s, 15, 2), D: smAt(s, 17, 2), nbits: s[19] };
        if (rt === 2 || rt === 3) {
          rep.NG = u(s, 31, 4); rep.widthRef = s[35]; rep.widthBits = s[36]; rep.lenRef = u(s, 37, 4); rep.lenInc = s[41]; rep.lastLen = u(s, 42, 4); rep.lenBits = s[46];
          if (rep.rawMiss = s[22]) rep.missing = true;
          if (rt === 3) { rep.order = s[47]; rep.octets = s[48]; }
        }
      } else if (sn === 6) {
        var ind = s[5];
        if (ind === 255) bitmap = null;
        else if (ind === 0) { bitmap = []; for (var b = 0; b < (sl - 6) * 8; b++) bitmap.push(!!((s[6 + (b >> 3)] >> (7 - (b & 7))) & 1)); }
        else bitmap = { bad: true };
      } else if (sn === 7) {
        var what = disc === 0 && prod && prod.cat === 2 && [0, 1, 2, 3].indexOf(prod.num) >= 0 ? ["wdir", "wspd", "u10", "v10"][prod.num] : null;
        if (what && prod.level === 10 && prod.surface === 103) {
          if (!grid || grid.bad) skipped.push({ param: what, reason: grid ? grid.bad : "no grid" });
          else if (!rep) skipped.push({ param: what, reason: "no data representation" });
          else if (bitmap && bitmap.bad) skipped.push({ param: what, reason: "bitmap indicator" });
          else if (rep.missing && (rep.tpl === 2 || rep.tpl === 3)) skipped.push({ param: what, reason: "complex packing with missing values" });
          else {
            try {
              var n = grid.ni * grid.nj; if (bitmap) bitmap = bitmap.slice(0, n);
              var vals = unpack2(rep, s, n, bitmap);
              out.push({ edition: 2, param: what, ref: ref, fcstH: prod.fh, valid: ref + prod.fh * 3600000, grid: grid.g, values: normalise(vals, grid.ni, grid.nj, grid.scan) });
            } catch (e) { skipped.push({ param: what, reason: e.message }); }
          }
        }
      }
      p += sl;
    }
    return len;
  }

  // ---------- GRIB1 ----------
  function parse1(d, o, skipped, out) {
    var len = u(d, o + 4, 3), p = o + 8, pds = d.subarray(p, p + u(d, p, 3)); p += pds.length;
    var flags = pds[7], gds = null, bms = null;
    if (flags & 0x80) { gds = d.subarray(p, p + u(d, p, 3)); p += gds.length; }
    if (flags & 0x40) { bms = d.subarray(p, p + u(d, p, 3)); p += bms.length; }
    var bds = d.subarray(p, p + u(d, p, 3));
    var par = pds[8], what = { 33: "u10", 34: "v10", 31: "wdir", 32: "wspd" }[par];
    if (!what) return len;
    var lvl = pds[9] === 105 ? u(pds, 10, 2) : null; if (lvl !== 10) return len;
    var reason = null;
    if (!gds) reason = "no grid"; else if (gds[5] !== 0) reason = "grid type " + gds[5]; else if (bms) reason = "bitmap"; else if (bds[3] & 0xc0) reason = "complex or spherical packing";
    if (reason) { skipped.push({ param: what, reason: reason }); return len; }
    var year = (pds[24] - 1) * 100 + pds[12], ref = Date.UTC(year, pds[13] - 1, pds[14], pds[15], pds[16]);
    var unit = UNIT_H[pds[17]] || 1, tr = pds[20], P1 = tr === 10 ? u(pds, 18, 2) : pds[18], fh = tr === 0 || tr === 10 || tr === 1 ? P1 * unit : pds[19] * unit;
    var D = smAt(pds, 26, 2), E = smAt(bds, 4, 2), R = ibm32(bds, 6), nb = bds[10];
    var ni = u(gds, 6, 2), nj = u(gds, 8, 2), la1 = smAt(gds, 10, 3) / 1000, lo1 = smAt(gds, 13, 3) / 1000, la2 = smAt(gds, 17, 3) / 1000, lo2 = smAt(gds, 20, 3) / 1000, di = u(gds, 23, 2) / 1000, dj = u(gds, 25, 2) / 1000, scan = gds[27];
    var n = ni * nj, vals = new Float64Array(n), dec = Math.pow(10, -D), sc = Math.pow(2, E);
    var data = bds.subarray(11);
    try {
      for (var k = 0; k < n; k++) vals[k] = (R + (nb ? bits(data, k * nb, nb) : 0) * sc) * dec;
      out.push({ edition: 1, param: what, ref: ref, fcstH: fh, valid: ref + fh * 3600000, grid: gridOf(ni, nj, la1, lo1, la2, lo2, di, dj, scan), values: normalise(vals, ni, nj, scan) });
    } catch (e) { skipped.push({ param: what, reason: e.message }); }
    return len;
  }

  function parse(buf) {
    var d = buf instanceof Uint8Array ? buf : new Uint8Array(buf), out = [], skipped = [], o = 0, msgs = 0;
    while (o + 8 <= d.length) {
      if (!(d[o] === 0x47 && d[o + 1] === 0x52 && d[o + 2] === 0x49 && d[o + 3] === 0x42)) { o++; continue; }   // "GRIB"
      var ed = d[o + 7], len;
      try { len = ed === 2 ? parse2(d, o, skipped, out) : ed === 1 ? parse1(d, o, skipped, out) : (skipped.push({ reason: "GRIB edition " + ed }), 8); }
      catch (e) { skipped.push({ reason: "message at byte " + o + ": " + e.message }); len = 8; }
      msgs++; o += Math.max(8, len);
    }
    return { fields: out, skipped: skipped, messages: msgs };
  }

  // wind field: a list of times, each with U and V (m/s) on one grid
  function buildWind(fields) {
    var by = {}, grid = null, ignored = 0;
    fields.forEach(function (f) {
      if (!grid) grid = f.grid;
      var g = f.grid; if (g.ni !== grid.ni || g.nj !== grid.nj || Math.abs(g.lonW - grid.lonW) > 1e-6 || Math.abs(g.latN - grid.latN) > 1e-6) { ignored++; return; }
      (by[f.valid] = by[f.valid] || {})[f.param] = f.values;
    });
    var times = Object.keys(by).map(Number).sort(function (a, b) { return a - b; }), U = [], V = [], tt = [];
    times.forEach(function (t) {
      var e = by[t], uu, vv;
      if (e.u10 && e.v10) { uu = e.u10; vv = e.v10; }
      else if (e.wspd && e.wdir) { uu = new Float32Array(e.wspd.length); vv = new Float32Array(e.wspd.length); for (var i = 0; i < uu.length; i++) { var r = e.wdir[i] * Math.PI / 180; uu[i] = -e.wspd[i] * Math.sin(r); vv[i] = -e.wspd[i] * Math.cos(r); } }
      else return;
      tt.push(t); U.push(uu); V.push(vv);
    });
    return tt.length ? { times: tt, grid: grid, u: U, v: V, ignored: ignored } : null;
  }
  function cell(w, k, lat, lon) {
    var g = w.grid, lo = lon; while (lo < g.lonW) lo += 360; while (lo >= g.lonW + 360) lo -= 360;
    var x = (lo - g.lonW) / g.di, y = (g.latN - lat) / g.dj;
    if (x < 0 || y < 0 || x > g.ni - 1 || y > g.nj - 1) return null;
    var i0 = Math.min(g.ni - 2 < 0 ? 0 : g.ni - 2, Math.floor(x)), j0 = Math.min(g.nj - 2 < 0 ? 0 : g.nj - 2, Math.floor(y)), fx = x - i0, fy = y - j0;
    function at(A, i, j) { return A[Math.min(g.nj - 1, j) * g.ni + Math.min(g.ni - 1, i)]; }
    function bil(A) { return (1 - fy) * ((1 - fx) * at(A, i0, j0) + fx * at(A, i0 + 1, j0)) + fy * ((1 - fx) * at(A, i0, j0 + 1) + fx * at(A, i0 + 1, j0 + 1)); }
    return { u: bil(w.u[k]), v: bil(w.v[k]) };
  }
  function sample(w, lat, lon, tMs) {
    if (!w || !fin(lat) || !fin(lon) || !fin(tMs)) return null;
    var t = w.times, n = t.length; if (tMs < t[0] || tMs > t[n - 1]) return null;
    var k = 0; while (k < n - 2 && tMs > t[k + 1]) k++;
    var a = cell(w, k, lat, lon), b = n > 1 ? cell(w, k + 1, lat, lon) : a; if (!a || !b) return null;
    var f = n > 1 ? (tMs - t[k]) / (t[k + 1] - t[k]) : 0, uu = a.u + (b.u - a.u) * f, vv = a.v + (b.v - a.v) * f;
    if (!fin(uu) || !fin(vv)) return null;
    return { tws_kn: Math.hypot(uu, vv) / KN, twd_deg: ((Math.atan2(-uu, -vv) * 180 / Math.PI) % 360 + 360) % 360, u: uu, v: vv };
  }
  function bounds(w) { var g = w.grid; return { north: g.latN, south: g.latN - (g.nj - 1) * g.dj, west: g.lonW, east: g.lonW + (g.ni - 1) * g.di, from: w.times[0], to: w.times[w.times.length - 1] }; }

  var api = { parse: parse, buildWind: buildWind, sample: sample, bounds: bounds };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRGrib = api;
})(this);
