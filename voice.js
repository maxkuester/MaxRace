// MaxRace voice: the tactician asks in Italian through the AirPods (press the stem, or the mic button) and MaxRace
// answers in the earphones, with the boat's own data. Everything runs on the phone, no internet needed.
//
//   "incrocio le barche sopra?"        who crosses ahead of whom, then keeps you posted until the crossing is done
//   "il vento?" / "rotazione 5 minuti" TWD shift and pressure over the last minutes
//   "pinga la comitato" / "pinga pin"  "tre, due, uno, ora!" and the line end is taken on "ora"
//   "linea" / "quanto manca"           countdown, distance and time to the line, time to burn
//   "boa"                              distance, bearing and time to the mark
//   "layline"                          time and distance to the laylines
//   "velocità" / "come andiamo"        boat speed, % of target, VMG
//   "stop"                             quiet, and stops the updates
// Plus, if turned on in Settings: wind shifts said as they happen, and the start countdown.
//
// The page gives window.MRT (own, hist, ais, cam, startInfo, cdRem, ping, layInfo, dtwBtw, perfNow, targets, nat, native).
(function () {
  "use strict";
  var D2R = Math.PI / 180, R2D = 180 / Math.PI, KN = 1852 / 3600;
  function fin(v) { return typeof v === "number" && isFinite(v); }
  function wrap360(a) { return ((a % 360) + 360) % 360; }
  function wrap180(a) { return ((a % 360) + 540) % 360 - 180; }
  function load(k, d) { try { var v = localStorage.getItem("mrv." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem("mrv." + k, JSON.stringify(v)); } catch (e) {} }
  var M = function () { return window.MRT; };

  var cfg = { stem: load("stem", true), shifts: load("shifts", true), shiftDeg: load("shiftDeg", 5), countdown: load("countdown", true), burn: load("burn", true), boatLen: load("boatLen", 9.6) };
  var st = { listening: false, watch: null, lastShift: 0, lastCd: null, onState: null, heard: "" };

  // ---------- speaking ----------
  function say(text, opts) {
    opts = opts || {};
    if (!text) return;
    text = text.charAt(0).toUpperCase() + text.slice(1);
    console.log("[voice] say", text);
    st.lastSaid = text;
    if (st.onSay) st.onSay(text);
    var m = M();
    if (m && m.native) { m.nat({ cmd: "say", text: text, flush: !!opts.flush }); return; }
    if (!window.speechSynthesis) return;
    if (opts.flush) speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text); u.lang = "it-IT"; u.rate = 1.05;
    var v = speechSynthesis.getVoices().filter(function (x) { return /^it/i.test(x.lang); })[0]; if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  function hush() { var m = M(); if (m && m.native) m.nat({ cmd: "sayStop" }); else if (window.speechSynthesis) speechSynthesis.cancel(); }

  // Italian for numbers the voice reads well
  function n1(x) { return (Math.round(x * 10) / 10).toString().replace(".", ","); }
  function metres(m) { m = Math.abs(m); return m < 1000 ? Math.round(m / (m < 100 ? 1 : 5)) * (m < 100 ? 1 : 5) + " metri" : n1(m / 1852) + " miglia"; }
  function secs(s) {
    s = Math.round(Math.abs(s)); var mn = Math.floor(s / 60), r = s % 60;
    if (!mn) return r + " secondi";
    return (mn === 1 ? "un minuto" : mn + " minuti") + (r ? " e " + r : "");
  }
  function deg(d) { return ("00" + Math.round(wrap360(d))).slice(-3).replace(/^0/, "").replace(/^0/, "") ; }
  function lengths(m) { var l = Math.abs(m) / cfg.boatLen; return l < 1 ? "meno di una lunghezza" : Math.round(l) === 1 ? "una lunghezza" : Math.round(l) + " lunghezze"; }

  // ---------- listening ----------
  function listen() {
    var m = M(); hush();
    st.listening = true; state();
    if (m && m.native) { m.nat({ cmd: "listen" }); return; }
    var R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) { st.listening = false; state(); say("Il riconoscimento vocale non c'è in questo browser. Usa l'app MaxRace."); return; }
    var r = new R(); r.lang = "it-IT"; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = function (e) { heard({ text: e.results[0][0].transcript, final: true }); };
    r.onerror = function () { st.listening = false; state(); };
    r.onend = function () { st.listening = false; state(); };
    r.start();
  }
  function heard(o) {
    console.log("[voice] heard", JSON.stringify(o));
    st.heard = o.text || "";
    if (o.final) { st.listening = false; state(); if (st.heard) answer(st.heard); else say("Non ho sentito."); }
    else state();
  }
  function state() { if (st.onState) st.onState({ listening: st.listening, heard: st.heard, watching: !!st.watch }); }
  window.MRN = window.MRN || {};
  window.MRN.heard = heard;
  window.MRN.voiceState = function (o) { console.log("[voice] state", JSON.stringify(o)); if (o && o.error) { st.listening = false; state(); say(o.error); } if (o && o.stem) listen(); };

  // ---------- understanding ----------
  function answer(q) {
    var t = q.toLowerCase();
    if (/\b(stop|basta|zitto|silenzio|ferma)\b/.test(t)) { stopWatch(); hush(); say("Ok.", { flush: true }); return; }
    if (/ping|pinga|pingo|pinghiamo/.test(t)) return pingLine(/pin\b|boa|sinistra|pin$/.test(t.replace(/ping[a-z]*/g, "")) ? "pin" : "boat");
    if (/incroc|passo davanti|passiamo davanti|passo dietro|chi passa/.test(t)) return crossing(/sopra|sopravento/.test(t) ? "up" : /sotto|sottovento/.test(t) ? "down" : "all", true);
    if (/layline|lay line|virata|virare|viro|strambo|strambare/.test(t)) return laylines();
    if (/sincr|sync|allinea|tondo|arrotonda/.test(t)) return cdSyncV();
    var cm = t.match(/(countdown|conto alla rovescia|timer|cronometro|parti|partire|via)\D{0,12}(\d+|un|uno|due|tre|quattro|cinque|sei|dieci)\s*minut/);
    if (cm) return cdStartV(word(cm[2]));
    if (/linea|partenza|manca|countdown|conto alla rovescia|bruciare|brucio|burn/.test(t)) return lineInfo();
    if (/vento|rotaz|salto|ruota|gira|raffica|pressione/.test(t)) { var mm = t.match(/(\d+|un|uno|due|tre|quattro|cinque|sei|dieci)\s*minut/); return wind(mm ? word(mm[1]) : 2); }
    if (/boa|marca|mark|bearing/.test(t)) return mark();
    if (/velocit|target|polare|come andiamo|andiamo|vmg/.test(t)) return speed();
    say("Non ho capito. Puoi chiedere: incroci, vento, linea, pinga comitato, boa, layline, velocità.");
  }
  function word(x) { return { un: 1, uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, dieci: 10 }[x] || +x || 2; }

  // ---------- wind: shift and pressure over the last minutes ----------
  function meanTwd(rows) {
    var x = 0, y = 0, n = 0; rows.forEach(function (r) { if (fin(r.twd)) { x += Math.sin(r.twd * D2R); y += Math.cos(r.twd * D2R); n++; } });
    return n ? wrap360(Math.atan2(x, y) * R2D) : NaN;
  }
  function meanOf(rows, k) { var s = 0, n = 0; rows.forEach(function (r) { if (fin(r[k])) { s += r[k]; n++; } }); return n ? s / n : NaN; }
  function windNow(min) {
    var h = M().hist(), now = Date.now();
    var a = h.filter(function (r) { return now - r.t <= 20000; }), b = h.filter(function (r) { return Math.abs(now - min * 60000 - r.t) <= 30000; });
    return { now: meanTwd(a), then: meanTwd(b), tws: meanOf(a, "tws"), tws0: meanOf(b, "tws") };
  }
  function wind(min) {
    var w = windNow(min);
    if (!fin(w.now)) { say("Non ho dati di vento."); return; }
    if (!fin(w.then)) { say("Vento " + deg(w.now) + ", " + n1(w.tws) + " nodi. Non ho ancora " + min + " minuti di storia."); return; }
    var d = wrap180(w.now - w.then), p = w.tws - w.tws0, txt;
    txt = Math.abs(d) < 2 ? "Vento stabile negli ultimi " + (min === 1 ? "un minuto" : min + " minuti") : "Rotazione a " + (d > 0 ? "destra" : "sinistra") + " di " + Math.round(Math.abs(d)) + " gradi negli ultimi " + (min === 1 ? "un minuto" : min + " minuti");
    txt += ". Ora " + deg(w.now) + ", " + n1(w.tws) + " nodi";
    if (fin(p) && Math.abs(p) >= 1) txt += ", " + (p > 0 ? "rinforza" : "cala") + " di " + n1(Math.abs(p));
    say(txt + ".");
  }
  // said by itself: a shift of the 30 s wind against the 5 minute mean
  function shiftWatch() {
    if (!cfg.shifts || !M()) return;
    var h = M().hist(), now = Date.now();
    var a = meanTwd(h.filter(function (r) { return now - r.t <= 30000; })), b = meanTwd(h.filter(function (r) { return now - r.t <= 300000; }));
    if (!fin(a) || !fin(b) || h.length < 180) return;
    var d = wrap180(a - b);
    if (Math.abs(d) >= cfg.shiftDeg && now - st.lastShift > 120000) {
      st.lastShift = now;
      say("Salto a " + (d > 0 ? "destra" : "sinistra") + " di " + Math.round(Math.abs(d)) + " gradi. Vento " + deg(a) + ".");
    }
  }

  // ---------- crossings: who passes ahead, from camera targets (with tack) and AIS ----------
  function boats() {
    var m = M(), S = m.own(), out = [], now = Date.now();
    var cam = m.cam ? m.cam() : {};
    Object.keys(cam).forEach(function (id) {
      var tg = cam[id], age = (now - tg.t) / 1000; if (age > 300 || tg.cog == null) return;
      var p = tg.sog > 0 ? m.dest(tg.lat, tg.lon, tg.cog, tg.sog * Math.min(age, 300) / 3600) : tg;
      out.push({ name: tg.name || id, lat: p.lat, lon: p.lon, cog: tg.cog, sog: tg.sog, known: tg.tackKnown });
    });
    var ais = m.ais ? m.ais() : {};
    Object.keys(ais).forEach(function (k) {
      var a = ais[k]; if (!fin(a.lat) || !fin(a.cog) || !fin(a.sog) || now - a.t > 180000) return;
      out.push({ name: a.name || ("AIS " + (a.mmsi || "")), lat: a.lat, lon: a.lon, cog: a.cog, sog: a.sog, known: true });
    });
    return out;
  }
  // where a boat crosses our course line, and by how much ahead or behind us (+ = it passes ahead of us)
  function crossOf(b, S) {
    var kx = 111120 * Math.cos(S.lat * D2R), R = [(b.lon - S.lon) * kx, (b.lat - S.lat) * 111120];
    var co = fin(S.cog) ? S.cog : S.hdg, so = (fin(S.sog) ? S.sog : S.bsp) * KN, u = [Math.sin(co * D2R), Math.cos(co * D2R)];
    var V = [Math.sin(b.cog * D2R) * b.sog * KN, Math.cos(b.cog * D2R) * b.sog * KN];
    var cr = function (p, q) { return p[0] * q[1] - p[1] * q[0]; };
    var den = cr(u, V); if (Math.abs(den) < 0.3 || !(so > 0.5)) return null;
    var tx = -cr(u, R) / den; if (tx < 0 || tx > 600) return null;
    var along = u[0] * (R[0] + V[0] * tx) + u[1] * (R[1] + V[1] * tx);
    if (along < 0) return null;
    var up = fin(S.twd) ? R[0] * Math.sin(S.twd * D2R) + R[1] * Math.cos(S.twd * D2R) : 0;
    return { name: b.name, t: tx, margin: along - so * tx, up: up, dist: Math.hypot(R[0], R[1]), known: b.known };
  }
  function crossList(side) {
    var S = M().own(); if (!fin(S.lat)) return null;
    return boats().map(function (b) { return crossOf(b, S); }).filter(function (c) {
      return c && (side === "all" || (side === "up" ? c.up > 0 : c.up < 0));
    }).sort(function (a, b) { return a.t - b.t; }).slice(0, 3);
  }
  function crossText(c) {
    var who = c.name.replace(/^C(\d+)$/, "T$1");
    var s = c.margin > 0 ? who + " ci passa davanti di " : "passiamo davanti a " + who + " di ";
    return s + lengths(c.margin) + ", tra " + secs(c.t) + (c.known ? "" : ", mure non sicure");
  }
  function crossing(side, first) {
    var S = M().own();
    if (!fin(S.lat)) { say("Non ho la nostra posizione."); return; }
    var L = crossList(side), where = side === "up" ? " sopra" : side === "down" ? " sotto" : "";
    if (!L.length) { say("Nessuna barca in rotta d'incrocio" + where + ". Inquadrale con la camera per sapere le mure."); stopWatch(); return; }
    say(L.map(crossText).join(". ") + ".", { flush: first });
    // keep the tactician posted: a new answer when a margin changes by a length or flips, and when it is done
    stopWatch();
    var last = {}; L.forEach(function (c) { last[c.name] = c.margin; });
    var until = Date.now() + 5 * 60000;
    st.watch = setInterval(function () {
      if (Date.now() > until) { stopWatch(); return; }
      var N = crossList(side) || [], msgs = [];
      Object.keys(last).forEach(function (n) {
        var c = N.filter(function (x) { return x.name === n; })[0];
        if (!c) { msgs.push("incrocio con " + n.replace(/^C(\d+)$/, "T$1") + " fatto"); delete last[n]; return; }
        if (Math.sign(c.margin) !== Math.sign(last[n]) || Math.abs(c.margin - last[n]) >= cfg.boatLen) { msgs.push(crossText(c)); last[n] = c.margin; }
      });
      if (msgs.length) say(msgs.join(". ") + ".");
      if (!Object.keys(last).length) stopWatch();
    }, 8000);
    state();
  }
  function stopWatch() { if (st.watch) clearInterval(st.watch); st.watch = null; state(); }

  // ---------- start line ----------
  function pingLine(which) {
    var name = which === "pin" ? "pin" : "comitato";
    say("Pingo " + name + ". Tre", { flush: true });
    setTimeout(function () { say("due"); }, 1000);
    setTimeout(function () { say("uno"); }, 2000);
    setTimeout(function () {
      M().ping(which); say("ora!");
      setTimeout(function () {
        var si = M().startInfo();
        if (si && fin(si.len)) say("Linea " + metres(si.len * 1852) + (si.fav && fin(si.biasDeg) ? ", favorito " + (si.fav === "pin" ? "il pin" : "il comitato") + " di " + Math.round(si.biasDeg) + " gradi" : "") + ".");
        else say(name === "pin" ? "Pin preso. Ora pinga il comitato." : "Comitato preso. Ora pinga il pin.");
      }, 900);
    }, 3000);
  }
  function lineInfo() {
    var m = M(), r = m.cdRem(), si = m.startInfo(), parts = [];
    if (fin(r)) parts.push(r > 0 ? "Mancano " + secs(r) : "Partiti da " + secs(r));
    if (!si) { parts.push("linea non impostata: di' pinga comitato, poi pinga pin"); say(parts.join(". ") + "."); return; }
    var d = si.d * 1852;
    parts.push(d > 0 ? "Sei oltre la linea di " + metres(d) : "Sei a " + metres(d) + " dalla linea");
    if (fin(si.ttl) && d < 0) parts.push("ci arrivi in " + secs(si.ttl));
    if (fin(r) && r > 0 && fin(si.ttl)) parts.push(r - si.ttl >= 0 ? "hai " + secs(r - si.ttl) + " da bruciare" : "sei in ritardo di " + secs(si.ttl - r));
    if (si.fav && fin(si.biasDeg)) parts.push("favorito " + (si.fav === "pin" ? "il pin" : "il comitato") + " di " + Math.round(si.biasDeg) + " gradi");
    say(parts.join(", ") + ".");
  }
  // started by voice: "countdown 5 minuti", "sincro" rounds to the nearest minute (on the signal)
  function cdStartV(min) { M().setCD(min * 60); st.lastCd = null; say("Countdown " + (min === 1 ? "un minuto" : min + " minuti") + ", partito.", { flush: true }); }
  function cdSyncV() { var r = M().cdSync(); if (!fin(r)) { say("Il countdown non è partito. Di' countdown cinque minuti."); return; } st.lastCd = null; say("Sincronizzato, " + (r ? secs(r) : "zero") + ".", { flush: true }); }
  // time to burn, as on the Start page: countdown minus time to the line at this speed
  function burnText(r) {
    var si = M().startInfo(); if (!si || !fin(si.ttl) || !(r > 0)) return "";
    var b = r - si.ttl, a = Math.round(Math.abs(b));
    if (a < 2) return ", in tempo";
    var t = a < 60 ? String(a) : secs(a);
    return b > 0 ? ", brucia " + t : ", in ritardo " + t;
  }
  // the countdown said by itself: every minute, 45, 30, 20, 15 (with the time to burn), 10 to 1, and the gun
  function countdownWatch() {
    if (!cfg.countdown || !M()) return;
    var r = M().cdRem(); if (!fin(r) || r < -2 || r > 600) { st.lastCd = null; return; }
    var s = Math.ceil(r), key = null, txt = null;
    if (s >= 60 && s % 60 === 0) { key = s; txt = s === 60 ? "un minuto" : (s / 60) + " minuti"; }
    else if (s === 45 || s === 30 || s === 20 || s === 15) { key = s; txt = s + " secondi"; }
    else if (s <= 10 && s >= 1) { key = s; txt = String(s); }
    else if (s <= 0 && r > -1.5) { key = 0; txt = "via!"; }
    if (txt && st.lastCd !== key) {
      st.lastCd = key;
      if (s > 10 && cfg.burn) txt += burnText(r);
      say(txt, { flush: s <= 10 });
    }
  }

  // ---------- mark, laylines, speed ----------
  function mark() {
    var m = M(), o = m.dtwBtw(), S = m.own();
    if (!fin(o.d)) { say("Nessuna boa attiva."); return; }
    var vm = m.vmc(), txt = "Boa a " + metres(o.d * 1852) + (fin(o.b) ? ", bearing " + deg(o.b) : "");
    if (fin(vm) && vm > 0.3) txt += ", ci arrivi in " + secs(o.d / vm * 3600);
    say(txt + ".");
  }
  function laylines() {
    var li = M().layInfo(); if (!li) { say("Serve una boa attiva e il vento per le layline."); return; }
    var parts = [];
    ["port", "stbd"].forEach(function (k) {
      var x = li[k], nm = k === "port" ? "mure a sinistra" : "mure a dritta"; if (!x) return;
      if (x.past) parts.push("layline " + nm + " superata");
      else if (x.hit) parts.push("layline " + nm + (x.mode === "this tack" ? "" : " dopo la virata") + " tra " + (fin(x.spd) && x.spd > 0.3 ? secs(x.d / x.spd * 3600) + ", " : "") + metres(x.d * 1852));
    });
    say(parts.length ? parts.join(". ") + "." : "Nessuna layline in avvicinamento.");
  }
  function speed() {
    var m = M(), S = m.own(), p = m.perfNow(), txt = fin(S.bsp) ? n1(S.bsp) + " nodi" : "Non ho la velocità";
    if (fin(p)) txt += ", " + Math.round(p * 100) + " per cento del target";
    var vmg = fin(S.bsp) && fin(S.twa) ? Math.abs(S.bsp * Math.cos(S.twa * D2R)) : NaN;
    if (fin(vmg)) txt += ", VMG " + n1(vmg);
    say(txt + ".");
  }

  setInterval(function () { try { shiftWatch(); } catch (e) {} }, 5000);
  setInterval(function () { try { countdownWatch(); } catch (e) {} }, 250);

  // the earphone stem talks only when turned on (it makes MaxRace the "now playing" app)
  function stemOn(on) { var m = M(); if (m && m.native) m.nat({ cmd: "voiceOn", on: !!on }); }

  window.MRVoice = {
    listen: listen, say: say, answer: answer, cfg: cfg, st: st, stemOn: stemOn,
    set: function (k, v) { cfg[k] = v; save(k, v); if (k === "stem") stemOn(v); },
    init: function () { if (cfg.stem) stemOn(true); }
  };
})();
