// Synthetic check: BSP reads 5% low (true = 1.05 x), compass +3 deg, current 1 kn along the track. node scripts/test-speedcal.js
var S = require("../speedcal.js"), assert = require("assert");
var pts = [], t = 0;
function run(hdgTrue, secs) {
  for (var i = 0; i < secs; i++, t++) {
    var w = 6, hdgRead = hdgTrue + 3 + Math.sin(i / 7) * 1.5;               // reading 3 deg off, small steering wobble
    var cur = hdgTrue < 180 ? 1 : -1;                                       // set 1 kn: helps on the first heading, hurts on the reverse
    pts.push({ t: t, hdg: hdgRead, bsp: w / 1.05, sog: w + cur, cog: hdgTrue, twa: hdgTrue < 180 ? 45 : -45 });
  }
}
run(45, 90); t += 10; for (var i = 0; i < 12; i++, t++) pts.push({ t: t, hdg: 45 + i * 15, bsp: 4, sog: 4, cog: 45 + i * 15 });
run(225, 90); t += 20; run(40, 90); t += 10; for (i = 0; i < 12; i++, t++) pts.push({ t: t, hdg: 40 + i * 15, bsp: 4, sog: 4, cog: 40 + i * 15 }); run(220, 90);
var r = S.analyse(pts);
console.log(JSON.stringify(r.summary), r.runs.length, "runs", r.pairs.length, "pairs");
assert.strictEqual(r.pairs.length, 2);
// BSP true speed = sog-cur; reading bsp = w/1.05 -> factor = (w+1 + w-1)/(2 w/1.05) = 1.05
assert(Math.abs(r.summary.factor - 1.05) < 0.005, "factor 1.05");
assert(Math.abs(r.summary.offset - (-3)) < 0.8, "offset: COG - HDG = -3");
assert(r.summary.ok === true);
console.log("ok");
