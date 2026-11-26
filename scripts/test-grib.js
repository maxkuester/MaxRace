// grib.js against synthetic GRIB files built here (no real file is available offline): node scripts/test-grib.js
var G = require("../grib.js"), assert = require("assert");
var KN = 1852 / 3600;
function be(n, v) { var a = []; for (var i = n - 1; i >= 0; i--) a.push(Math.floor(v / Math.pow(2, 8 * i)) % 256); return a; }
function smb(n, v) { var a = be(n, Math.abs(v)); if (v < 0) a[0] |= 0x80; return a; }
function f32(v) { var b = Buffer.alloc(4); b.writeFloatBE(v); return Array.from(b); }
function packBits(vals, w) { var out = [], acc = 0, nacc = 0; vals.forEach(function (v) { for (var b = w - 1; b >= 0; b--) { acc = acc * 2 + (Math.floor(v / Math.pow(2, b)) % 2); nacc++; if (nacc === 8) { out.push(acc); acc = 0; nacc = 0; } } }); if (nacc) out.push(acc * Math.pow(2, 8 - nacc)); return out; }
function nbits(x) { var n = 0; while (Math.pow(2, n) <= x) n++; return n; }
function sec(n, body) { return be(4, body.length + 5).concat([n], body); }
var NI = 6, NJ = 5, LAT_N = 44.0, LON_W = 7.0, DI = 0.25, DJ = 0.25;
function field(fn) { var a = []; for (var j = 0; j < NJ; j++) for (var i = 0; i < NI; i++) a.push(Math.round(fn(i, j) * 100) / 100); return a; }
// --- GRIB2 message builder
function msg2(opts) {
  var sec1 = sec(1, [0, 98, 0, 0, 1, 1, 1].concat(be(2, 2026), [11, 26, 12, 0, 0, 0, 1]));
  var scan = opts.scan || 0, rows = [];
  var vals = opts.values.slice();
  if (scan & 0x40) { vals = []; for (var j = NJ - 1; j >= 0; j--) for (var i = 0; i < NI; i++) vals.push(opts.values[j * NI + i]); }
  var la1 = scan & 0x40 ? LAT_N - (NJ - 1) * DJ : LAT_N, la2 = scan & 0x40 ? LAT_N : LAT_N - (NJ - 1) * DJ;
  var sec3 = sec(3, [0].concat(be(4, NI * NJ), [0, 0], be(2, 0), [6, 0], be(4, 0), [0], be(4, 0), [0], be(4, 0), be(4, NI), be(4, NJ), be(4, 0), be(4, 0), smb(4, Math.round(la1 * 1e6)), smb(4, Math.round(LON_W * 1e6)), [48], smb(4, Math.round(la2 * 1e6)), smb(4, Math.round((LON_W + (NI - 1) * DI) * 1e6)), be(4, DI * 1e6), be(4, DJ * 1e6), [scan]));
  var sec4 = sec(4, [0, 0].concat(be(2, 0), [opts.cat, opts.num, 2, 0, 0, 0, 0, 0], [1], be(4, opts.fh), [103, 0], be(4, opts.level === undefined ? 10 : opts.level), [255, 0], be(4, 0)));
  var ints = vals.map(function (v) { return Math.round(v * 100); }), sec5, sec7;
  if (opts.tpl === 0) {
    var mn = Math.min.apply(null, ints), X = ints.map(function (v) { return v - mn; }), nb = nbits(Math.max.apply(null, X));
    sec5 = sec(5, be(4, ints.length).concat(be(2, 0), f32(mn), smb(2, 0), smb(2, 2), [nb, 0]));
    sec7 = sec(7, packBits(X, nb));
  } else {
    var order = opts.tpl === 3 ? 2 : 0, Z = ints.slice(), h = [], gmin = 0;
    if (order) {
      var d = []; for (var k = 2; k < ints.length; k++) d.push(ints[k] - 2 * ints[k - 1] + ints[k - 2]);
      gmin = Math.min.apply(null, d); h = [ints[0], ints[1]]; Z = [0, 0].concat(d.map(function (v) { return v - gmin; }));
    } else { var m0 = Math.min.apply(null, ints); Z = ints.map(function (v) { return v - m0; }); opts.R = m0; }
    var GS = 4, groups = []; for (var q = 0; q < Z.length; q += GS) groups.push(Z.slice(q, q + GS));
    var refs = groups.map(function (g) { return Math.min.apply(null, g); }), widths = groups.map(function (g, i) { return nbits(Math.max.apply(null, g) - refs[i]); });
    var lens = groups.map(function (g) { return g.length; }), lastLen = lens[lens.length - 1];
    var rb = Math.max(1, nbits(Math.max.apply(null, refs))), wb = Math.max(1, nbits(Math.max.apply(null, widths))), lb = 1;
    var data = packBits(refs, rb).concat(packBits(widths, wb), packBits(lens.map(function (l, i) { return i === lens.length - 1 ? 0 : (l - GS); }), lb));
    groups.forEach(function (g, i) { data = data.concat(packBits(g.map(function (v) { return v - refs[i]; }), widths[i])); });
    // data bits of the groups are contiguous: repack them together so groups do not each pad to a byte
    var gv = [], gw = []; groups.forEach(function (g, i) { g.forEach(function (v) { gv.push(v - refs[i]); gw.push(widths[i]); }); });
    var bitsAll = []; gv.forEach(function (v, i) { for (var b = gw[i] - 1; b >= 0; b--) bitsAll.push(Math.floor(v / Math.pow(2, b)) % 2); });
    var gbytes = []; for (var bi = 0; bi < bitsAll.length; bi += 8) { var acc = 0; for (var bj = 0; bj < 8; bj++) acc = acc * 2 + (bitsAll[bi + bj] || 0); gbytes.push(acc); }
    data = packBits(refs, rb).concat(packBits(widths, wb), packBits(lens.map(function (l, i) { return i === lens.length - 1 ? 0 : (l - GS); }), lb), gbytes);
    var desc = []; if (order) { desc = smb(2, h[0]).concat(smb(2, h[1]), smb(2, gmin)); }
    var five = be(4, ints.length).concat(be(2, opts.tpl), f32(order ? 0 : opts.R), smb(2, 0), smb(2, 2), [rb, 0], [1, 0], be(4, 0), be(4, 0), be(4, groups.length), [0], [wb], be(4, GS), [1], be(4, lastLen), [lb]);
    if (order) five = five.concat([order, 2]);
    sec5 = sec(5, five); sec7 = sec(7, desc.concat(data));
  }
  var sec6 = sec(6, [255]);
  var body = [].concat(sec1, sec3, sec4, sec5, sec6, sec7), total = 16 + body.length + 4;
  return Buffer.from([0x47, 0x52, 0x49, 0x42, 0, 0, 0, 2].concat(be(8, total), body, [0x37, 0x37, 0x37, 0x37]));
}
var U = field(function (i, j) { return -3 + 0.8 * i - 0.5 * j; }), V = field(function (i, j) { return 2 + 0.3 * i + 0.9 * j; });
var U6 = field(function (i, j) { return -2 + 0.7 * i - 0.4 * j + 1; }), V6 = field(function (i, j) { return 1.5 + 0.25 * i + 0.8 * j; });
var files = Buffer.concat([
  msg2({ tpl: 0, cat: 2, num: 2, fh: 0, values: U }), msg2({ tpl: 0, cat: 2, num: 3, fh: 0, values: V, scan: 0x40 }),
  msg2({ tpl: 3, cat: 2, num: 2, fh: 6, values: U6 }), msg2({ tpl: 2, cat: 2, num: 3, fh: 6, values: V6 }),
  msg2({ tpl: 0, cat: 3, num: 5, fh: 0, values: U }),                         // not a wind field: ignored
  msg2({ tpl: 0, cat: 2, num: 2, fh: 0, values: U, level: 100 })              // 100 m wind: ignored
]);
var r = G.parse(files);
console.log("fields", r.fields.map(function (f) { return f.param + "@" + f.fcstH; }).join(" "), "skipped", JSON.stringify(r.skipped));
assert.strictEqual(r.fields.length, 4); assert.strictEqual(r.skipped.length, 0);
function close(a, b, t) { assert(Math.abs(a - b) <= t, a + " vs " + b); }
r.fields.forEach(function (f) {
  var want = { "u10@0": U, "v10@0": V, "u10@6": U6, "v10@6": V6 }[f.param + "@" + f.fcstH];
  for (var k = 0; k < want.length; k++) close(f.values[k], want[k], 0.0051);
  assert.strictEqual(f.ref, Date.UTC(2026, 10, 26, 12, 0, 0));
});
var w = G.buildWind(r.fields);
assert.deepStrictEqual(w.times.map(function (t) { return (t - Date.UTC(2026, 10, 26, 12)) / 3600000; }), [0, 6]);
// sample exactly on a grid point at t = 0: lat 44, lon 7 -> (i0, j0): u=-3, v=2 (m/s): wind FROM the north-west quadrant
var t0 = Date.UTC(2026, 10, 26, 12), s0 = G.sample(w, 44.0, 7.0, t0);
close(s0.tws_kn, Math.hypot(-3, 2) / KN, 0.02); close(s0.twd_deg, (Math.atan2(3, -2) * 180 / Math.PI + 360) % 360, 0.1);
// between two points in space (bilinear on a plane is exact) and in time (halfway to +6 h)
var s1 = G.sample(w, 43.875, 7.125, t0 + 3 * 3600000), uu = (-3 + 0.8 * 0.5 - 0.5 * 0.5 + (-2 + 0.7 * 0.5 - 0.4 * 0.5 + 1)) / 2, vv = (2 + 0.3 * 0.5 + 0.9 * 0.5 + (1.5 + 0.25 * 0.5 + 0.8 * 0.5)) / 2;
close(s1.tws_kn, Math.hypot(uu, vv) / KN, 0.03);
assert.strictEqual(G.sample(w, 50, 7, t0), null, "outside the grid"); assert.strictEqual(G.sample(w, 44, 7, t0 + 7 * 3600000), null, "after the last forecast");
// GRIB1, direction and speed, simple packing, scan south to north
function ibm(v) { if (v === 0) return [0, 0, 0, 0]; var s = v < 0 ? 0x80 : 0, a = Math.abs(v), e = 0; while (a >= 1) { a /= 16; e++; } while (a < 1 / 16) { a *= 16; e--; } var m = Math.round(a * 16777216); return [s | (e + 64)].concat(be(3, m)); }
function msg1(param, values) {
  var pds = [].concat(be(3, 28), [2, 98, 255, 255, 0xc0 & 0x80, param, 105], be(2, 10), [26, 11, 26, 12, 0, 1, 0, 0, 0, 0, 0, 0, 21, 0], be(2, 0), [0, 0]); pds[7] = 0x80;
  pds = pds.slice(0, 28); while (pds.length < 28) pds.push(0);
  pds[24] = 21; pds[26] = 0; pds[27] = 1;                                   // century 21, decimal scale factor D = 1 (values were stored x10)
  var rows = []; for (var j = NJ - 1; j >= 0; j--) for (var i = 0; i < NI; i++) rows.push(values[j * NI + i]);        // scan south to north
  var gds = [].concat(be(3, 32), [0, 255, 0], be(2, NI), be(2, NJ), smb(3, Math.round((LAT_N - (NJ - 1) * DJ) * 1000)), smb(3, LON_W * 1000), [128], smb(3, LAT_N * 1000), smb(3, (LON_W + (NI - 1) * DI) * 1000), be(2, DI * 1000), be(2, DJ * 1000), [0x40], [0, 0, 0, 0]);
  var ints = rows.map(function (v) { return Math.round(v * 10); }), mn = Math.min.apply(null, ints), X = ints.map(function (v) { return v - mn; }), nb = nbits(Math.max.apply(null, X));
  var pk = packBits(X, nb), bds = [].concat(be(3, 11 + pk.length + (pk.length % 2)), [0], smb(2, 0), ibm(mn), [nb], pk); if (pk.length % 2) bds.push(0);
  var body = [].concat(pds, gds, bds), total = 8 + body.length + 4;
  return Buffer.from([0x47, 0x52, 0x49, 0x42].concat(be(3, total), [1], body, [0x37, 0x37, 0x37, 0x37]));
}
var SPD = field(function (i, j) { return 5 + 0.4 * i + 0.2 * j; }), DIR = field(function (i, j) { return 250 + 3 * i - 2 * j; });
var r1 = G.parse(Buffer.concat([msg1(32, SPD), msg1(31, DIR)]));
console.log("grib1", r1.fields.map(function (f) { return f.param; }), JSON.stringify(r1.skipped));
assert.strictEqual(r1.fields.length, 2);
var w1 = G.buildWind(r1.fields), g1 = G.sample(w1, 44.0, 7.0, Date.UTC(2026, 10, 26, 12));
close(g1.tws_kn, 5 / KN, 0.1); close(g1.twd_deg, 250, 0.2);
// unsupported packing is reported, not guessed
var bad = msg2({ tpl: 0, cat: 2, num: 2, fh: 0, values: U }); var idx = bad.indexOf(Buffer.from([0, 0, 0, 0]));   // find sec 5 and force template 5.40
var p5 = 16 + sec(1, [0, 98, 0, 0, 1, 1, 1].concat(be(2, 2026), [11, 26, 12, 0, 0, 0, 1])).length;
var tmp = Array.from(bad); var o = 16; while (tmp[o + 4] !== 5) o += (tmp[o] * 16777216 + tmp[o + 1] * 65536 + tmp[o + 2] * 256 + tmp[o + 3]); tmp[o + 9] = 0; tmp[o + 10] = 40;
var rb = G.parse(Buffer.from(tmp)); assert.strictEqual(rb.fields.length, 0); assert(/5\.40/.test(rb.skipped[0].reason), rb.skipped[0].reason);
assert.deepStrictEqual(G.parse(Buffer.from("not a grib file")).fields, []);
console.log("ok");
