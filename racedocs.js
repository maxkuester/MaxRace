// MaxRace race documents: reads what a tactician needs from the text of a Notice of Race, Sailing Instructions or an
// amendment (Italian or English), as a list of items to CONFIRM, never applied by itself.
//   mark    a position (degrees/minutes[/seconds] or decimal degrees, N/S and E/W) with the words next to it as its name
//   time    warning signal / first start / time limits, as written (hh:mm) with the sentence it comes from
//   vhf     the VHF channel
//   limit   protest time limit, race time limit, in minutes where the text gives them
//   course  lines that name the course type (windward-leeward, triangle, bolina/poppa ...)
// extract(lines) -> {items:[{kind, label, lat, lon, value, line, text}]}: line is the 1-based source line, text the sentence.
// Nothing is invented: an item exists only if its text is in the document. Works in the page (window.MRRaceDocs) and in Node.
(function (root) {
  "use strict";
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function norm(s) {
    return String(s).replace(/[º˚]/g, "°").replace(/[′ʹ’‘´`]/g, "'").replace(/[″”“]/g, '"').replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  }
  function num(s) { return parseFloat(String(s).replace(",", ".")); }
  var HEM = "[NSEWO]";
  // one coordinate: optional hemisphere letter before or after; degrees, then minutes (decimal), then optional seconds, or decimal degrees
  var TOK = new RegExp("(?:^|[^A-Za-z0-9.])(" + HEM + ")?\\s?(\\d{1,3})(?:\\s?°\\s?|\\s)(?:(\\d{1,2}(?:[.,]\\d+)?)\\s?'?(?:\\s?(\\d{1,2}(?:[.,]\\d+)?)\\s?(?:\"|''))?)?\\s?(" + HEM + ")?(?![A-Za-z0-9])", "g");
  var DEC = new RegExp("(?:^|[^A-Za-z0-9.])(" + HEM + ")?\\s?(-?\\d{1,3}[.,]\\d{3,})\\s?°?\\s?(" + HEM + ")?(?![A-Za-z0-9.,])", "g");

  function toVal(h, deg, min, sec) {
    var v = deg + (fin(min) ? min / 60 : 0) + (fin(sec) ? sec / 3600 : 0);
    return h === "S" || h === "W" ? -v : v;
  }
  // coordinate pairs in one line: [{lat, lon, index}]
  function pairs(line) {
    var out = [], toks = [], m, s = " " + line;
    TOK.lastIndex = 0;
    while ((m = TOK.exec(s))) {
      var h = (m[1] || m[5] || "").toUpperCase(); if (!h) continue;
      if (m[1] && m[5] && m[1].toUpperCase() !== m[5].toUpperCase()) h = m[5].toUpperCase();
      var deg = parseInt(m[2], 10), min = m[3] != null ? num(m[3]) : NaN, sec = m[4] != null ? num(m[4]) : NaN;
      if (h === "O") h = "E";
      var lat = h === "N" || h === "S";
      if (deg > (lat ? 90 : 180) || (fin(min) && min >= 60) || (fin(sec) && sec >= 60)) continue;
      if (!fin(min) && !/°/.test(m[0])) continue;                       // a bare "43 N" is not a position
      toks.push({ lat: lat, v: toVal(h, deg, min, sec), i: m.index, end: TOK.lastIndex });
      TOK.lastIndex = Math.max(TOK.lastIndex - 1, m.index + 1);
    }
    DEC.lastIndex = 0;
    while ((m = DEC.exec(s))) {
      var h2 = (m[1] || m[3] || "").toUpperCase(); if (!h2) continue; if (h2 === "O") h2 = "E";
      var v = num(m[2]), lat2 = h2 === "N" || h2 === "S"; if (Math.abs(v) > (lat2 ? 90 : 180)) continue;
      toks.push({ lat: lat2, v: h2 === "S" || h2 === "W" ? -Math.abs(v) : v, i: m.index, end: DEC.lastIndex });
    }
    toks.sort(function (a, b) { return a.i - b.i; });
    var dedup = [];
    toks.forEach(function (t) { if (!dedup.length || t.i >= dedup[dedup.length - 1].end - 1) dedup.push(t); });
    for (var k = 0; k + 1 < dedup.length; k++) {
      var a = dedup[k], b = dedup[k + 1];
      if (a.lat && !b.lat && b.i - a.end <= 20) { out.push({ lat: a.v, lon: b.v, i: a.i }); k++; }
      else if (!a.lat && b.lat && b.i - a.end <= 20) { out.push({ lat: b.v, lon: a.v, i: a.i }); k++; }
    }
    return out;
  }

  function labelFor(lines, n, idx) {
    var cur = norm(lines[n]), before = cur.slice(0, Math.max(0, idx)).replace(/[:;,\-–—|=()\[\]]+\s*$/, "").trim();
    before = before.replace(/^[\d]+[.)]\s*/, "").replace(/\s*\b(?:at|in|a|@|position|posizione|lat(?:itude)?|lon(?:gitude)?)\s*$/i, "").trim();
    before = before.replace(/\(([^)]*)$/, "$1").trim();
    if (/:\s*\S{2,}/.test(before)) before = before.slice(before.lastIndexOf(":") + 1).trim();   // "Start line: Committee boat" -> the mark's own name
    if (before.length >= 2) return before.slice(-40).replace(/^[^A-Za-z0-9]+/, "");
    var prev = n > 0 ? norm(lines[n - 1]) : "";
    if (prev && prev.length <= 40 && !pairs(prev).length) return prev.replace(/[:;,\-–—]+$/, "").trim();
    return "";
  }
  var T = "(\\d{1,2})\\s?(?:[:.h]|h\\s?)\\s?(\\d{2})(?!\\d)";
  var RULES = [
    { kind: "time", re: new RegExp("(first\\s+warning\\s+signal|warning\\s+signal|first\\s+start|prima\\s+partenza|segnale\\s+di\\s+avviso|primo\\s+segnale|start(?:ing)?\\s+time|ora\\s+di\\s+partenza)[^\\d]{0,60}?" + T, "i"), label: function (m) { return m[1].toLowerCase(); }, value: function (m) { return ("0" + m[2]).slice(-2) + ":" + m[3]; } },
    { kind: "time", re: new RegExp("(no\\s+start\\s+after|nessuna\\s+partenza\\s+dopo|latest\\s+start|ultima\\s+partenza)[^\\d]{0,40}?" + T, "i"), label: function (m) { return m[1].toLowerCase(); }, value: function (m) { return ("0" + m[2]).slice(-2) + ":" + m[3]; } },
    { kind: "vhf", re: /\b(?:VHF|canale|channel|ch\.?)\s*(?:channel|canale|ch\.?)?\s*[:n°.]?\s*(\d{1,2})(?!\d)/i, label: function () { return "VHF channel"; }, value: function (m) { return m[1]; }, need: /VHF/i },
    { kind: "limit", re: /(protest(?:\s+time)?\s+limit|time\s+limit\s+for\s+protests?|termine\s+(?:per\s+)?(?:le\s+)?proteste?|tempo\s+limite\s+(?:per\s+le\s+)?proteste?)[^\d]{0,50}?(\d{1,3})\s?(?:min|minutes?|minuti)/i, label: function () { return "protest time limit"; }, value: function (m) { return m[2] + " min"; } },
    { kind: "limit", re: /(time\s+limit|tempo\s+limite|tempo\s+massimo)[^\d]{0,40}?(\d{1,3})\s?(?:min|minutes?|minuti|hours?|ore|h)\b/i, label: function () { return "race time limit"; }, value: function (m) { return m[0].slice(m[0].search(/\d/)).trim(); }, not: /protest|protesta/i },
    { kind: "course", re: /(windward[\s-]*leeward|bolina[\s-]*poppa|triangle|triangolo|trapezoid|trapezio|banana|sausage|salsiccia|coastal|costiero|percorso|course\b)/i, label: function (m) { return m[1].toLowerCase(); }, value: function () { return ""; }, need: /windward|leeward|bolina|poppa|triang|trapez|banana|sausage|salsiccia|coastal|costier/i }
  ];

  function extract(lines) {
    var items = [], seenMark = {}, seenTxt = {};
    (lines || []).forEach(function (raw, n) {
      var line = norm(raw); if (!line) return;
      pairs(line).forEach(function (p) {
        if (!(Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180) || (p.lat === 0 && p.lon === 0)) return;
        var key = p.lat.toFixed(4) + "," + p.lon.toFixed(4);   // about 10 m: the same mark written twice is one item
         if (seenMark[key]) return; seenMark[key] = 1;
        items.push({ kind: "mark", label: labelFor(lines, n, p.i - 1), lat: p.lat, lon: p.lon, value: "", line: n + 1, text: line.slice(0, 160) });
      });
      RULES.forEach(function (r) {
        if (r.need && !r.need.test(line)) return; if (r.not && r.not.test(line)) return;
        var m = r.re.exec(line); if (!m) return;
        var it = { kind: r.kind, label: r.label(m), lat: NaN, lon: NaN, value: r.value(m), line: n + 1, text: line.slice(0, 160) };
        var k = it.kind + "|" + it.label + "|" + it.value; if (seenTxt[k]) return; seenTxt[k] = 1; items.push(it);
      });
    });
    return { items: items };
  }
  function fromText(text) { return extract(String(text || "").split(/\r?\n/)); }
  var api = { extract: extract, fromText: fromText, pairs: pairs };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MRRaceDocs = api;
})(this);
