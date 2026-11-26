// 10 m wind from NOAA GFS (public AWS bucket), cut to your area, as a small GRIB2 file MaxRace can open (Settings > Wind forecast).
//   node scripts/fetch-gfs-wind.js --lat 44.36 --lon 8.57 [--span 3] [--hours 96] [--step 3] [--out varazze.grb]
// Takes the latest GFS run that is already complete, downloads only the U and V 10 m messages (byte ranges from the .idx files, about 1 MB each
// for the whole globe), reads them with grib.js and writes the area (lat/lon +- span degrees) with simple packing (0.01 m/s steps).
"use strict";
const fs = require("fs");
const G = require("../grib.js");
const B = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const lat = +arg("lat"), lon = +arg("lon"), span = +arg("span", 3), hours = +arg("hours", 96), step = +arg("step", 3), out = arg("out", "gfs-wind.grb");
if (!isFinite(lat) || !isFinite(lon)) { console.error("usage: node scripts/fetch-gfs-wind.js --lat 44.36 --lon 8.57 [--span 3] [--hours 96] [--step 3] [--out file.grb]"); process.exit(1); }

const be = (n, v) => { const a = []; for (let i = n - 1; i >= 0; i--) a.push(Math.floor(v / Math.pow(2, 8 * i)) % 256); return a; };
const smb = (n, v) => { const a = be(n, Math.abs(v)); if (v < 0) a[0] |= 0x80; return a; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatBE(v); return Array.from(b); };
const nbits = (x) => { let n = 0; while (Math.pow(2, n) <= x) n++; return n; };
function packBits(vals, w) { const o = []; let acc = 0, na = 0; vals.forEach((v) => { for (let b = w - 1; b >= 0; b--) { acc = acc * 2 + (Math.floor(v / Math.pow(2, b)) % 2); if (++na === 8) { o.push(acc); acc = 0; na = 0; } } }); if (na) o.push(acc * Math.pow(2, 8 - na)); return o; }
const sec = (n, body) => be(4, body.length + 5).concat([n], body);
// one GRIB2 message: regular lat/lon grid, simple packing, parameter 0/2/(2|3) at 10 m
function message(f, sub) {
  const { ni, nj, latN, lonW, di, dj, vals } = sub, d = new Date(f.ref);
  const s1 = sec(1, [0, 98, 0, 0, 1, 1, 1].concat(be(2, d.getUTCFullYear()), [d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), 0, 0, 1]));
  const lonE = lonW + (ni - 1) * di, latS = latN - (nj - 1) * dj, norm = (x) => Math.round(((x % 360) + 360) % 360 * 1e6);
  const s3 = sec(3, [0].concat(be(4, ni * nj), [0, 0], be(2, 0), [6, 0], be(4, 0), [0], be(4, 0), [0], be(4, 0), be(4, ni), be(4, nj), be(4, 0), be(4, 0), smb(4, Math.round(latN * 1e6)), be(4, norm(lonW)), [48], smb(4, Math.round(latS * 1e6)), be(4, norm(lonE)), be(4, Math.round(di * 1e6)), be(4, Math.round(dj * 1e6)), [0]));
  const s4 = sec(4, [0, 0].concat(be(2, 0), [2, f.param === "u10" ? 2 : 3, 2, 0, 0, 0, 0, 0], [1], be(4, f.fcstH), [103, 0], be(4, 10), [255, 0], be(4, 0)));
  const ints = vals.map((v) => Math.round(v * 100)), mn = Math.min(...ints), X = ints.map((v) => v - mn), nb = nbits(Math.max(...X));
  const s5 = sec(5, be(4, ints.length).concat(be(2, 0), f32(mn), smb(2, 0), smb(2, 2), [nb, 0])), s7 = sec(7, packBits(X, nb)), s6 = sec(6, [255]);
  const body = [].concat(s1, s3, s4, s5, s6, s7);
  return Buffer.from([0x47, 0x52, 0x49, 0x42, 0, 0, 0, 2].concat(be(8, 16 + body.length + 4), body, [0x37, 0x37, 0x37, 0x37]));
}
function cut(f) {
  const g = f.grid, i0 = Math.floor(((((lon - span) % 360) + 360) % 360 - g.lonW) / g.di), i1 = Math.ceil(((((lon + span) % 360) + 360) % 360 - g.lonW) / g.di);
  const ni = ((i1 - i0 + g.ni) % g.ni) + 1, j0 = Math.floor((g.latN - Math.min(90, lat + span)) / g.dj), j1 = Math.ceil((g.latN - Math.max(-90, lat - span)) / g.dj), nj = j1 - j0 + 1, vals = [];
  for (let j = j0; j <= j1; j++) for (let i = 0; i < ni; i++) vals.push(f.values[j * g.ni + ((i0 + i) % g.ni)]);
  return { ni, nj, latN: g.latN - j0 * g.dj, lonW: g.lonW + i0 * g.di, di: g.di, dj: g.dj, vals };
}
async function get(url, range) { const r = await fetch(url, range ? { headers: { Range: "bytes=" + range } } : {}); if (!r.ok && r.status !== 206) throw new Error("HTTP " + r.status + " " + url); return Buffer.from(await r.arrayBuffer()); }
(async () => {
  // the newest run whose last wanted hour is already published
  const now = new Date(); let run = null;
  for (let back = 0; back < 8 && !run; back++) {
    const t = new Date(Math.floor((now.getTime() - back * 6 * 3600000) / (6 * 3600000)) * 6 * 3600000), ymd = t.toISOString().slice(0, 10).replace(/-/g, ""), cc = String(t.getUTCHours()).padStart(2, "0");
    const last = "f" + String(Math.floor(hours / step) * step).padStart(3, "0");
    try { await get(`${B}/gfs.${ymd}/${cc}/atmos/gfs.t${cc}z.pgrb2.0p25.${last}.idx`); run = { ymd, cc }; } catch (e) { /* not there yet */ }
  }
  if (!run) throw new Error("no complete GFS run found");
  console.log("GFS run " + run.ymd + " " + run.cc + "z, hours 0.." + hours + " every " + step + " h, area " + (lat - span) + ".." + (lat + span) + "N, " + (lon - span) + ".." + (lon + span) + "E");
  const parts = [];
  for (let fh = 0; fh <= hours; fh += step) {
    const base = `${B}/gfs.${run.ymd}/${run.cc}/atmos/gfs.t${run.cc}z.pgrb2.0p25.f${String(fh).padStart(3, "0")}`, idx = (await get(base + ".idx")).toString().trim().split("\n");
    for (const v of ["UGRD", "VGRD"]) {
      const k = idx.findIndex((l) => l.indexOf(":" + v + ":10 m above ground:") > 0); if (k < 0) throw new Error("no " + v + " in " + base);
      const a = +idx[k].split(":")[1], b = k + 1 < idx.length ? +idx[k + 1].split(":")[1] - 1 : "";
      const r = G.parse(await get(base, a + "-" + b)); if (r.skipped.length || r.fields.length !== 1) throw new Error("cannot read " + v + " f" + fh + ": " + JSON.stringify(r.skipped));
      parts.push(message(r.fields[0], cut(r.fields[0])));
    }
    process.stdout.write(".");
  }
  fs.writeFileSync(out, Buffer.concat(parts)); console.log("\n" + out + ": " + parts.length + " messages, " + Buffer.concat(parts).length + " bytes");
})().catch((e) => { console.error(e.message); process.exit(1); });
