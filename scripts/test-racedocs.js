// node scripts/test-racedocs.js
var R = require("../racedocs.js"), assert = require("assert");
var txt = [
  "NOTICE OF RACE - Coppa Test 2026",
  "Start line: Committee boat 43°37.250'N 007°23.100'E",
  "Pin end",
  "43° 37' 14.0\" N, 7° 22' 58.0\" E",
  "Mark 1 (windward): 43.6400 N 7.4000 E",
  "Boa di sottovento: 43°35,900'N; 007°24,500'E",
  "The first warning signal will be made at 11:55. Protest time limit is 90 minutes after the last boat finishes.",
  "Segnale di avviso: ore 12.25",
  "Communication: VHF channel 72",
  "Courses will be windward-leeward, 2 laps.",
  "Time limit 3 hours; wind 12 knots at 270°, 5 mm of rain, boat 2026 N",
  "Date 43 37 250 nothing here"
];
var r = R.extract(txt), by = function (k) { return r.items.filter(function (i) { return i.kind === k; }); };
var m = by("mark"); console.log(m.map(function (x) { return x.label + " " + x.lat.toFixed(4) + " " + x.lon.toFixed(4); }));
assert.strictEqual(m.length, 4, "4 marks");
assert(Math.abs(m[0].lat - 43.62083) < 1e-4 && Math.abs(m[0].lon - 7.385) < 1e-4);
assert(/windward/.test(m[2].label) && !/\(/.test(m[2].label), "label without a stray bracket");
assert.strictEqual(R.extract(["Mark A 43°37.250'N 007°23.100'E", "again 43°37.250'N 007°23.100'E"]).items.length, 1, "same position once");
assert(m[0].label === "Committee boat", "label from the same line, after the colon");
assert(/pin end/i.test(m[1].label) && Math.abs(m[1].lat - (43 + 37 / 60 + 14 / 3600)) < 1e-5, "label from the line before, seconds");
assert(Math.abs(m[3].lat - 43.59833) < 1e-4 && Math.abs(m[3].lon - 7.40833) < 1e-4, "comma decimals and semicolon");
var t = by("time").map(function (x) { return x.value; }); assert.deepStrictEqual(t, ["11:55", "12:25"]);
assert.deepStrictEqual(by("vhf").map(function (x) { return x.value; }), ["72"]);
assert(by("limit").some(function (x) { return x.label === "protest time limit" && x.value === "90 min"; }));
assert(by("limit").some(function (x) { return x.label === "race time limit"; }));
assert(by("course").length >= 1);
assert.strictEqual(R.extract(["wind 12 knots at 270°, 5 N of the harbour", "Page 43 N"]).items.filter(function (i) { return i.kind === "mark"; }).length, 0, "no false marks");
console.log("ok", r.items.length, "items");
