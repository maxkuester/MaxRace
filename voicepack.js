// MaxRace voice pack: the tactician's own voice (cloned on the Mac, scripts/voicepack-gen.py) instead of the phone's.
// What MaxRace says is built from a fixed set of pieces: whole sentences, phrases, words and the numbers. Each piece is a
// short audio clip; a sentence is played as its pieces one after the other, with short pauses at the punctuation.
// If a sentence has a piece we have no clip for (a boat's AIS name, say), the whole sentence goes to the phone's voice.
//
//   MRVoicePack.plan(text)  -> [{k: piece} | {p: ms}]  or  {missing: [...]}
//   MRVoicePack.units()     -> every piece: {k: key, say: text the voice model reads}
// Node: module.exports, for the generator and the tests. Browser: window.MRVoicePack, plus load() and play().
(function (root) {
  "use strict";
  var UNITS = [
    // ---- whole sentences and fixed calls ----
    "ok", "non ho sentito", "non ho capito", "puoi chiedere", "incroci", "se viro", "vento", "linea", "pinga comitato", "boa", "layline", "velocità",
    "non ho la nostra posizione", "non ho dati di vento", "non ho la velocità", "nessuna boa attiva", "nessuna layline in avvicinamento",
    "serve una boa attiva e il vento per le layline",
    "il riconoscimento vocale non c'è in questo browser", "usa l'app maxrace",
    "bolina, ora!", "vira, ora!", "via!", "ora!", "tre", "due", "uno",
    "bolina tra", "vira tra",
    "puoi virare", "non più", "virando", "al pelo", "mure non sicure",
    "virando non incroci nessuna barca vicina", "inquadrale con la camera", "o servono gli ais",
    "siamo in poppa", "il calcolo della virata vale di bolina",
    "nessuna barca in rotta d'incrocio", "nessuna barca in rotta d'incrocio sopra", "nessuna barca in rotta d'incrocio sotto",
    "inquadrale con la camera per sapere le mure",
    "linea non impostata", "di' pinga comitato", "poi pinga pin",
    "pin preso", "ora pinga il comitato", "comitato preso", "ora pinga il pin", "pingo il pin", "pingo il comitato", "pingo pin", "pingo comitato",
    "sei oltre la linea", "né orzando né virando arrivi alla linea da qui",
    "il countdown non è partito", "di' countdown cinque minuti", "sincronizzato", "zero", "partito",
    "calibrazione", "bolina per trenta secondi", "bolina, trenta secondi", "poggia al traverso e tieni quindici secondi", "orza di bolina, ora!",
    "salto questo passo", "misuro, tieni la bolina", "calibrazione interrotta", "calibrazione finita",
    "di' applica calibrazione per usarla in partenza", "non ho ancora misure da applicare", "applicata",
    "vento vero coerente tra le mure", "se si ripete", "controlla la taratura di bussola e awa", "non ho misurato abbastanza",
    "probabile taratura degli strumenti", "attenzione",
    // ---- pieces of the sentences that carry numbers or names ----
    "la barca", "la barca sopra avanti a", "la barca sopra al traverso a", "la barca sopra dietro a",
    "la barca sotto avanti a", "la barca sotto al traverso a", "la barca sotto dietro a", "la barca a prua a", "la barca a poppa a",
    "la barca a dritta a", "la barca a sinistra a",
    "alla barca sopra avanti a", "alla barca sopra al traverso a", "alla barca sopra dietro a",
    "alla barca sotto avanti a", "alla barca sotto al traverso a", "alla barca sotto dietro a", "alla barca a prua a", "alla barca a poppa a",
    "alla barca a dritta a", "alla barca a sinistra a",
    "metri", "metri ci passa davanti di", "miglia", "miglia ci passa davanti di",
    "passiamo davanti", "di", "passi davanti di", "passi dietro di", "una lunghezza", "lunghezze", "una lunghezza e mezza", "lunghezze e mezza", "t", "meno di una lunghezza", "tra",
    "incrocio con", "fatto", "metri fatto",
    "secondi", "un minuto", "un minuto e", "minuti", "minuti e", "gradi", "nodi", "metri dalla linea", "metri dal pin", "gradi al secondo",
    "vento stabile negli ultimi", "vento stabile negli ultimi un minuto", "rotazione a destra di", "rotazione a sinistra di",
    "gradi negli ultimi", "gradi negli ultimi un minuto", "ora", "rinforza di", "cala di", "non ho ancora", "minuti di storia",
    "salto a destra di", "salto a sinistra di",
    "linea", "favorito il pin di", "favorito il comitato di",
    "mancano", "partiti da", "sei oltre la linea di", "sei a", "ci arrivi in", "hai", "secondi da bruciare", "minuti da bruciare",
    "un minuto da bruciare", "da bruciare", "sei in ritardo di",
    "countdown un minuto", "countdown", "minuti",
    "brucia", "in ritardo", "in tempo", "orzando in tempo", "virando in tempo", "orzando", "di bolina",
    "di bolina sei sulla linea in", "orzando sei sulla linea in", "virando sei sulla linea in", "oltre il pin", "oltre il comitato", "a", "vai ora",
    "virata", "persi", "orzata", "guadagnati", "secondi sul modello", "a velocità in", "accostata",
    "il vento vero cambia di", "gradi tra le mure",
    "il vento vero è", "gradi più a destra sulle mure a dritta che a sinistra", "gradi più a sinistra sulle mure a dritta che a sinistra",
    "boa a", "bearing", "layline mure a sinistra superata", "layline mure a dritta superata",
    "layline mure a sinistra tra", "layline mure a dritta tra", "layline mure a sinistra dopo la virata tra", "layline mure a dritta dopo la virata tra",
    "per cento del target", "vmg"
  ];
  // what the voice model reads for a piece, when the written form would come out wrong
  var SAY = { "layline": "léilain", "vmg": "vi emme gi", "awa": "a vu a", "ais": "a i esse", "maxrace": "max reis",
    "pin": "pin", "countdown": "càuntdaun", "bearing": "bèring", "t": "ti" };
  var ONES = ["zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci", "undici", "dodici", "tredici",
    "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove"];
  var TENS = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"];
  function word(n) {                                   // 0..100 and the hundreds, in letters
    if (n < 20) return ONES[n];
    if (n === 100) return "cento";
    if (n % 100 === 0) return ONES[n / 100] + "cento";
    var t = TENS[Math.floor(n / 10)], u = n % 10;
    if (u === 1 || u === 8) t = t.slice(0, -1);        // ventuno, ventotto
    return t + (u ? (u === 3 ? "tré" : ONES[u]) : "");
  }
  function numKeys(s) {                                // "226" -> ["#200", "#26"], "7,5" -> ["#7", "#,", "#5"]
    var p = s.split(","), out = [];
    function whole(n) {
      if (n <= 100) { out.push("#" + n); return; }
      if (n < 1000) { out.push("#" + Math.floor(n / 100) * 100); if (n % 100) out.push("#" + (n % 100)); return; }
      out.push(null);                                  // no clips for thousands: the phone's voice says it
    }
    whole(+p[0]);
    if (p.length > 1) { out.push("#,"); p[1].split("").forEach(function (d) { out.push("#" + d); }); }
    return out;
  }
  var KEYS = {}, MAXW = 1;
  function norm(t) { return t.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim(); }
  UNITS.forEach(function (u) { var k = norm(u).replace(/[.,:;!?]+$/, "").replace(/,/g, ""); KEYS[k] = u; MAXW = Math.max(MAXW, k.split(" ").length); });
  // fixed calls with punctuation inside ("bolina, ora!") are matched with the commas taken out
  function plan(text) {
    var t = norm(text).replace(/(\d),(\d)/g, "$1§$2").replace(/%/g, " per cento");
    var out = [], missing = [];
    // the punctuation inside a fixed call is part of it: try those first on the whole sentence pieces
    var clauses = t.split(/([.:;!?]+|,)/);
    var words = [];                                    // a flat list: words, numbers and pauses
    clauses.forEach(function (c) {
      if (/^[.:;!?]+$/.test(c)) { words.push({ p: /[:]/.test(c) ? 250 : 380 }); return; }
      if (c === ",") { words.push({ p: 170, comma: true }); return; }
      c.split(/(\d+(?:§\d+)?)/).forEach(function (s, i) {
        if (i % 2) { words.push({ n: s.replace("§", ",") }); return; }
        s.trim().split(" ").forEach(function (w) { if (w) words.push({ w: w }); });
      });
    });
    // greedy: the longest run of words (a comma may sit inside a fixed call) that is a piece
    for (var i = 0; i < words.length;) {
      var x = words[i];
      if (x.p) { if (out.length && !out[out.length - 1].p) out.push({ p: x.p }); i++; continue; }
      if (x.n != null) { numKeys(x.n).forEach(function (k) { if (k) out.push({ k: k }); else missing.push(x.n); }); i++; continue; }
      var best = 0, key = null;
      for (var j = i, run = [], nw = 0; j < words.length && nw < MAXW; j++) {
        if (words[j].comma) continue;
        if (!words[j].w) break;
        run.push(words[j].w); nw++;
        var k = run.join(" ");
        if (KEYS[k] != null) { best = j + 1; key = k; }
      }
      if (!key) { missing.push(x.w); i++; continue; }
      out.push({ k: key }); i = best;
    }
    while (out.length && out[out.length - 1].p) out.pop();
    return missing.length ? { missing: missing } : out;
  }
  function units() {
    var u = Object.keys(KEYS).map(function (k) {
      var s = KEYS[k].replace(/\b[\wàèéìòù']+\b/g, function (w) { return SAY[w] || w; });
      return { k: k, say: s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") };
    });
    for (var n = 0; n <= 100; n++) u.push({ k: "#" + n, say: word(n).charAt(0).toUpperCase() + word(n).slice(1) + "." });
    for (n = 200; n < 1000; n += 100) u.push({ k: "#" + n, say: word(n).charAt(0).toUpperCase() + word(n).slice(1) + "." });
    u.push({ k: "#,", say: "Virgola." });
    return u;
  }
  function file(k) {                                   // a safe file name for a piece
    return k.replace(/^#,$/, "n_virgola").replace(/^#/, "n_").replace(/[àá]/g, "a").replace(/[èé]/g, "e").replace(/[ìí]/g, "i").replace(/[òó]/g, "o").replace(/[ùú]/g, "u")
      .replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") + ".m4a";
  }
  var api = { plan: plan, units: units, file: file, word: word, numKeys: numKeys };

  // ---------- browser: load the clips, play a sentence ----------
  if (typeof window !== "undefined") {
    var ctx = null, buf = {}, idx = null, cur = null, queue = [], playing = false;
    api.ready = function () { return !!idx; };
    api.load = function (base) {
      base = base || "voicepack/";
      return fetch(base + "index.json").then(function (r) { if (!r.ok) throw new Error("no voice pack"); return r.json(); }).then(function (j) {
        idx = j; idx.base = base; return j;
      });
    };
    function clip(k) {
      if (buf[k]) return Promise.resolve(buf[k]);
      var f = idx.files[k]; if (!f) return Promise.reject(new Error("missing " + k));
      return fetch(idx.base + f).then(function (r) { return r.arrayBuffer(); }).then(function (a) {
        return new Promise(function (ok, ko) { ctx.decodeAudioData(a, ok, ko); });
      }).then(function (b) { buf[k] = b; return b; });
    }
    // true when the sentence is played with the pack, false when it has to go to the phone's voice
    api.can = function (text) { if (!idx) return false; var p = plan(text); return !p.missing && p.every(function (x) { return x.p || idx.files[x.k]; }); };
    api.play = function (text, flush) {
      if (!api.can(text)) return false;
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
      if (flush) { queue = []; if (cur) { try { cur.stop(); } catch (e) {} cur = null; } playing = false; }
      queue.push(plan(text)); if (!playing) next();
      return true;
    };
    api.stop = function () { queue = []; if (cur) { try { cur.stop(); } catch (e) {} cur = null; } playing = false; };
    function next() {
      var p = queue.shift(); if (!p) { playing = false; return; }
      playing = true;
      Promise.all(p.map(function (x) { return x.p ? null : clip(x.k); })).then(function (bs) {
        // one buffer: the clips back to back, a short gap between words, longer at the punctuation
        var sr = ctx.sampleRate, gap = Math.round(0.04 * sr), len = 0;
        p.forEach(function (x, i) { len += x.p ? Math.round(x.p / 1000 * sr) : bs[i].length + gap; });
        var out = ctx.createBuffer(1, len, sr), d = out.getChannelData(0), o = 0;
        p.forEach(function (x, i) {
          if (x.p) { o += Math.round(x.p / 1000 * sr); return; }
          var b = bs[i], s = b.getChannelData(0), n = s.length, f = Math.min(Math.round(0.006 * sr), n >> 2);
          for (var q = 0; q < n; q++) d[o + q] = s[q] * (q < f ? q / f : q > n - f ? (n - q) / f : 1);
          o += n + gap;
        });
        var src = ctx.createBufferSource(); src.buffer = out; src.connect(ctx.destination);
        src.onended = function () { if (cur === src) { cur = null; next(); } };
        cur = src; src.start();
      }).catch(function (e) { console.log("[voicepack] " + e.message); playing = false; next(); });
    }
    root.MRVoicePack = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : this);
