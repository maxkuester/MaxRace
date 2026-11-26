// MaxRace mark import: reads marks from a GPX or KML file (what race committees and Expedition/other tools export).
//   GPX: <wpt> waypoints and <rte>/<rtept> route points; KML: <Placemark> with a <Point> (a LineString gives its points).
// parse(text) -> {format, marks: [{name, lat, lon, kind}], skipped}; kind is "wpt", "rte" or "kml". Order is the file's order.
// Works in the page (window.MRMarks) and in Node (module.exports). No DOM needed: plain text parsing.
(function (root) {
  "use strict";
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function dec(s) {
    return String(s == null ? "" : s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(+n); }).replace(/&amp;/g, "&").trim();
  }
  function tag(block, name) { var m = new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i").exec(block); return m ? dec(m[1]) : ""; }
  function attr(open, name) { var m = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(open); return m ? (m[1] != null ? m[1] : m[2]) : null; }
  function ok(lat, lon) { return fin(lat) && fin(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0); }

  function gpx(text, out) {
    var re = /<(wpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/gi, m;
    while ((m = re.exec(text))) {
      var lat = parseFloat(attr(m[2], "lat")), lon = parseFloat(attr(m[2], "lon")), body = m[4] || "";
      if (!ok(lat, lon)) { out.skipped++; continue; }
      out.marks.push({ name: tag(body, "name") || tag(body, "desc") || "", lat: lat, lon: lon, kind: m[1].toLowerCase() === "wpt" ? "wpt" : "rte" });
    }
  }
  function kml(text, out) {
    var re = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi, m;
    while ((m = re.exec(text))) {
      var name = tag(m[1], "name"), coords = /<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi, c, line = /<LineString\b/i.test(m[1]), n = 0;
      while ((c = coords.exec(m[1]))) {
        if (/<Polygon\b/i.test(m[1])) { out.skipped++; continue; }
        dec(c[1]).split(/\s+/).filter(Boolean).forEach(function (t) {
          var p = t.split(","), lon = parseFloat(p[0]), lat = parseFloat(p[1]);          // KML is lon,lat[,alt]
          if (!ok(lat, lon)) { out.skipped++; return; }
          n++; out.marks.push({ name: line ? (name ? name + " " + n : "") : name, lat: lat, lon: lon, kind: "kml" });
        });
      }
    }
  }
  function parse(text) {
    text = String(text || "");
    var out = { format: /<gpx\b/i.test(text) ? "gpx" : /<kml\b|<Placemark\b/i.test(text) ? "kml" : "", marks: [], skipped: 0 };
    if (out.format === "gpx") gpx(text, out); else if (out.format === "kml") kml(text, out);
    return out;
  }
  var api = { parse: parse };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRMarks = api;
})(this);
