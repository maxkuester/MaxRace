// node scripts/test-marksimport.js
var M = require("../marksimport.js"), assert = require("assert");
var g = M.parse('<?xml version="1.0"?><gpx version="1.1"><wpt lat="43.6208" lon="7.385"><name>Wind &amp; 1</name></wpt>' +
  '<wpt lat="43.6" lon="7.4"/><rte><rtept lat="43.5" lon="7.3"><name>Lee</name></rtept><rtept lat="95" lon="7"><name>bad</name></rtept></rte></gpx>');
assert.strictEqual(g.format, "gpx"); assert.strictEqual(g.marks.length, 3); assert.strictEqual(g.skipped, 1);
assert.strictEqual(g.marks[0].name, "Wind & 1"); assert.strictEqual(g.marks[0].kind, "wpt"); assert.strictEqual(g.marks[2].kind, "rte");
var k = M.parse('<kml><Document><Placemark><name><![CDATA[Gate]]></name><Point><coordinates>7.38,43.62,0</coordinates></Point></Placemark>' +
  '<Placemark><name>Line</name><LineString><coordinates>7.1,43.1,0 7.2,43.2,0</coordinates></LineString></Placemark></Document></kml>');
assert.strictEqual(k.format, "kml"); assert.strictEqual(k.marks.length, 3);
assert.deepStrictEqual([k.marks[0].name, k.marks[0].lat, k.marks[0].lon], ["Gate", 43.62, 7.38]); assert.strictEqual(k.marks[2].name, "Line 2");
assert.strictEqual(M.parse("hello").format, "");
console.log("ok");
