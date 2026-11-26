// MaxRace voice: the tactician asks in Italian through the AirPods (press the stem, or the mic button) and MaxRace
// answers in the earphones, with the boat's own data. Everything runs on the phone, no internet needed.
//
//   "incrocio le barche sopra?"        who crosses ahead of whom, then keeps you posted until the crossing is done
//   "se viro?" / "posso virare?"      if we tack now: ahead of or behind each nearby boat on our tack, in boat lengths
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

  var cfg = { stem: load("stem", true), shifts: load("shifts", true), shiftDeg: load("shiftDeg", 5), countdown: load("countdown", true), burn: load("burn", true), goCall: load("goCall", true), tackCall: load("tackCall", true), myVoice: load("myVoice", true), unit: load("unit", "len"), boatLen: load("boatLen", 9.6), llmOn: load("llmOn", false), llmAll: load("llmAll", false), llmModel: load("llmModel", "") };
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
    // the tactician's own voice when the voice pack has every piece of this sentence; else the phone's voice
    if (cfg.myVoice && window.MRVoicePack && window.MRVoicePack.play(text, !!opts.flush)) { if (m && m.native) m.nat({ cmd: "audioOn" }); return; }
    if (m && m.native) { m.nat({ cmd: "say", text: text, flush: !!opts.flush }); return; }
    if (!window.speechSynthesis) return;
    if (opts.flush) speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text); u.lang = "it-IT"; u.rate = 1.05;
    var vs = speechSynthesis.getVoices().filter(function (x) { return /^it/i.test(x.lang); });
    var v = vs.filter(function (x) { return /premium|enhanced|migliorat|natural|neural/i.test(x.name); })[0] || vs[0]; if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  function hush() { if (window.MRVoicePack) window.MRVoicePack.stop(); var m = M(); if (m && m.native) m.nat({ cmd: "sayStop" }); else if (window.speechSynthesis) speechSynthesis.cancel(); }

  // Italian for numbers the voice reads well
  function n1(x) { return (Math.round(x * 10) / 10).toString().replace(".", ","); }
  function metres(m) { m = Math.abs(m); return m < 1000 ? Math.round(m / (m < 100 ? 1 : 5)) * (m < 100 ? 1 : 5) + " metri" : n1(m / 1852) + " miglia"; }
  function secs(s) {
    s = Math.round(Math.abs(s)); var mn = Math.floor(s / 60), r = s % 60;
    if (!mn) return r + " secondi";
    return (mn === 1 ? "un minuto" : mn + " minuti") + (r ? " e " + r : "");
  }
  function deg(d) { return ("00" + Math.round(wrap360(d))).slice(-3).replace(/^0/, "").replace(/^0/, "") ; }
  // margins said in metres (by 5) or in boat lengths, as set in Settings > Voice
  function marginM(m) { var r = Math.max(5, Math.round(Math.abs(m) / 5) * 5); return r + " metri"; }
  function lengths(m) { if (cfg.unit === "m") return marginM(m); var l = Math.abs(m) / cfg.boatLen; return l < 1 ? "meno di una lunghezza" : Math.round(l) === 1 ? "una lunghezza" : Math.round(l) + " lunghezze"; }

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
    st.heard = o.text || ""; st.heardAt = Date.now();
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
    if (/\b(stop|basta|zitto|silenzio|ferma)\b/.test(t)) { stopWatch(); hush(); if (st.cal) { clearInterval(st.cal.tick); st.cal = null; } say("Ok.", { flush: true }); return; }
    if (cfg.llmOn && cfg.llmAll && llmKey() && !st.cal) return llmAnswer(q);
    if (/(appl|salva|usa)\w*\s+(la\s+|le\s+)?(velocit|correzion|bussola)/.test(t)) return speedApplyV();
    if (/(calibr|tarat|tarar)\w*.*(velocit|log\b|bussola|opposte|reciproc)|(velocit|bussola).*(calibr|tarat|tarar)/.test(t)) return /appl|salva|usa/.test(t) ? speedApplyV() : speedCalibrate();
    if (/\bvhf\b|che canale|canale radio|canale del comitato/.test(t)) return vhfAsk();
    if (/ping|pinga|pingo|pinghiamo/.test(t)) return pingLine(/pin\b|boa|sinistra|pin$/.test(t.replace(/ping[a-z]*/g, "")) ? "pin" : "boat");
    if (/se vir|posso virare|possiamo virare|virando|viro e pass|se cambio mure|se cambiamo mure|virata pass/.test(t)) return tackAsk();
    if (/incroc|passo davanti|passiamo davanti|passo dietro|chi passa/.test(t)) return crossing(/sopra|sopravento/.test(t) ? "up" : /sotto|sottovento/.test(t) ? "down" : "all", true);
    if (/lay ?-?line|eye ?-?liner|liner|lain|leila|le linee|linee|virata|virare|viro|strambo|strambare/.test(t)) return laylines();
    if (/calibra|taratura|tarare/.test(t)) return /appl|salva|usa/.test(t) ? calApplyV() : calibrate();
    if (st.cal && /(appl|salva|usa)\w*/.test(t)) return calApplyV();
    if (/orz|bolina|quando vado|quando parto|quando giro|spunt|vir[ao] o/.test(t)) return goInfo();
    if (/sincr|sync|allinea|tondo|arrotonda/.test(t)) return cdSyncV();
    var cm = t.match(/(countdown|conto alla rovescia|timer|cronometro|parti|partire|via)\D{0,12}(\d+|un|uno|due|tre|quattro|cinque|sei|dieci)\s*minut/);
    if (cm) return cdStartV(word(cm[2]));
    if (/linea|partenza|manca|countdown|conto alla rovescia|bruciare|brucio|burn/.test(t)) return lineInfo();
    if (/vento|rotaz|salto|ruota|gira|raffica|pressione/.test(t)) { var mm = t.match(/(\d+|un|uno|due|tre|quattro|cinque|sei|dieci)\s*minut/); return wind(mm ? word(mm[1]) : 2); }
    if (/boa|marca|mark|bearing/.test(t)) return mark();
    if (/velocit|target|polare|come andiamo|andiamo|vmg/.test(t)) return speed();
    if (cfg.llmOn && llmKey() && !st.cal) return llmAnswer(q);
    say("Non ho capito. Puoi chiedere: incroci, se viro, vento, linea, pinga comitato, boa, layline, velocità.");
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
    if (!cfg.shifts || !M() || st.cal) return;
    var h = M().hist(), now = Date.now();
    var a = meanTwd(h.filter(function (r) { return now - r.t <= 30000; })), b = meanTwd(h.filter(function (r) { return now - r.t <= 300000; }));
    if (!fin(a) || !fin(b) || h.length < 180) return;
    var d = wrap180(a - b);
    if (Math.abs(d) >= cfg.shiftDeg && now - st.lastShift > 120000) {
      st.lastShift = now;
      say("Salto a " + (d > 0 ? "destra" : "sinistra") + " di " + Math.round(Math.abs(d)) + " gradi. Vento " + deg(a) + ".");
    }
  }

  // ---------- who is who, said aloud: the AIS name when we have it, else where the boat is from us and how far ----------
  // sopra / sotto: on the windward or leeward side of our course, as said on board; a prua / a poppa when dead ahead or astern
  function where(brg) {
    var S = M().own(), h = fin(S.hdg) ? S.hdg : S.cog; if (!fin(brg) || !fin(h)) return "";
    var r = wrap180(brg - h), a = Math.abs(r);
    if (a < 15) return "a prua"; if (a > 165) return "a poppa";
    if (!fin(S.twa)) return r >= 0 ? "a dritta" : "a sinistra";
    return ((r >= 0) === (S.twa >= 0) ? "sopra" : "sotto") + (a < 75 ? " avanti" : a > 105 ? " dietro" : " al traverso");
  }
  // "Suspiria, Swan 42, sopra al traverso" with the entry list; "Suspiria" from AIS alone; else where it is and how far
  function who(c, short) {
    if (c.named) { var w0 = short ? "" : where(c.brg); return String(c.name) + (c.model ? ", " + c.model + (short ? "," : "") : "") + (w0 ? ", " + w0 : ""); }
    var w = where(c.brg);
    return "la barca " + (w ? w + " " : "") + "a " + metres(c.dist);
  }

  // ---------- crossings: who passes ahead, from camera targets (with tack) and AIS ----------
  function boats() {
    // the page's list: AIS and camera boats where they are now, one per boat, with the entry list's name and model
    var m = M(); return m.fleetBoats ? m.fleetBoats().map(function (b) { b.known = b.known !== false; return b; }) : [];
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
    return { name: b.name, named: b.named, model: b.model, brg: wrap360(Math.atan2(R[0], R[1]) * R2D), t: tx, margin: along - so * tx, up: up, dist: Math.hypot(R[0], R[1]), known: b.known };
  }
  function crossList(side) {
    var S = M().own(); if (!fin(S.lat)) return null;
    return boats().map(function (b) { return crossOf(b, S); }).filter(function (c) {
      return c && (side === "all" || (side === "up" ? c.up > 0 : c.up < 0));
    }).sort(function (a, b) { return a.t - b.t; }).slice(0, 3);
  }
  function crossText(c) {
    var w = who(c, true), W = w.charAt(0).toUpperCase() + w.slice(1);
    var s = c.margin > 0 ? W + " ci passa davanti di " : "passiamo davanti " + (c.named ? "a " : "al") + w + " di ";
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
    var last = {}, wl = {}; L.forEach(function (c) { last[c.name] = c.margin; wl[c.name] = who(c); });
    var until = Date.now() + 5 * 60000;
    st.watch = setInterval(function () {
      if (Date.now() > until) { stopWatch(); return; }
      var N = crossList(side) || [], msgs = [];
      Object.keys(last).forEach(function (n) {
        var c = N.filter(function (x) { return x.name === n; })[0];
        if (!c) { msgs.push("incrocio con " + (wl[n] || n) + " fatto"); delete last[n]; return; }
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
    var si = M().startInfo(); if (!si || !(r > 0)) return "";
    // not closing on the line (reaching along it, or running away): the burn if we luff up, or tack, now
    var how = "", ttl = si.ttl;
    if (!fin(ttl) || (si.luff && si.luff.ok && si.luff.turn >= 10)) {
      var x = si.luff && si.luff.ok ? si.luff : si.tackUp && si.tackUp.ok ? si.tackUp : null;
      if (!x) return "";
      ttl = x.time; how = x === si.luff ? " orzando" : " virando";
    }
    var b = r - ttl, a = Math.round(Math.abs(b));
    if (a < 2) return how ? "," + how + " in tempo" : ", in tempo";
    var t = a < 60 ? String(a) : secs(a);
    return (b > 0 ? ", brucia " : ", in ritardo ") + t + how;
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

  // ---------- going for the line: luff up to close-hauled (or tack) and sail at target ----------
  // the Start page's luff-up / tack-up options: x.time = manoeuvre + close-hauled at target to the line
  function goOpts() {
    var si = M().startInfo(), r = M().cdRem(); if (!si) return null;
    var o = [];
    if (si.luff && si.luff.ok) o.push({ k: "luff", x: si.luff, b: r - si.luff.time });
    if (si.tackUp && si.tackUp.ok) o.push({ k: "tack", x: si.tackUp, b: r - si.tackUp.time });
    return { si: si, r: r, o: o };
  }
  function whereOnLine(x, si) { return x.t < 0 ? "oltre il pin" : x.t > 1 ? "oltre il comitato" : "a " + metres(x.t * si.len * 1852) + " dal pin"; }
  function goInfo() {
    var g = goOpts(); if (!g) { say("Linea non impostata: di' pinga comitato, poi pinga pin."); return; }
    if (!g.o.length) { say(g.si.d > 0 ? "Sei oltre la linea." : "Né orzando né virando arrivi alla linea da qui."); return; }
    say(g.o.map(function (q) {
      var n = q.k === "luff" ? (q.x.turn < 10 ? "di bolina" : "orzando") : "virando";
      var t = n + " sei sulla linea in " + secs(q.x.time) + ", " + whereOnLine(q.x, g.si);
      if (fin(g.r) && g.r > 0) t += Math.abs(q.b) < 2 ? ", vai ora" : q.b > 0 ? ", brucia " + secs(q.b) : ", in ritardo " + secs(q.b);
      return t.charAt(0).toUpperCase() + t.slice(1);
    }).join(". ") + ".", { flush: true });
  }
  // said by itself before the gun: "bolina tra 10", "5", "Bolina, ora!" when luffing now hits the line at the gun.
  // Only when we are not already close-hauled (reaching, or running away); the tack is called if luffing cannot make it.
  function goWatch() {
    if (!cfg.goCall || !M()) return;
    var r = M().cdRem(); if (!fin(r) || r <= 0 || r > 240) { st.go = null; return; }
    var g = goOpts(); if (!g || !g.o.length) return;
    var q = g.o[0].k === "luff" && g.o[0].x.turn >= 10 ? g.o[0] : g.o[0].k === "tack" ? g.o[0] : null;
    if (!q) { st.go = null; return; }               // already close-hauled: the countdown and burn say it all
    var name = q.k === "luff" ? "bolina" : "vira", b = q.b, go = st.go || (st.go = {});
    if (b > 12) { go[q.k] = null; return; }           // re-arm when there is time again (bore away)
    var key = b <= 0.5 ? 0 : b <= 5.5 ? 5 : b <= 10.5 ? 10 : null;
    if (key == null || go[q.k] === key || (go[q.k] != null && go[q.k] < key)) return;
    if (key === 0 && b < -4) return;                  // long past: do not shout late
    go[q.k] = key;
    say(key === 0 ? (q.k === "luff" ? "Bolina, ora!" : "Vira, ora!") : name + " tra " + key, { flush: true });
  }

  // ---------- "se viro?": if we tack now, who do we pass ahead of, and who do we have to duck (page: tackCross) ----------
  function tackLen(c) {
    if (cfg.unit === "m") return marginM(c.margin);
    var l = Math.abs(c.margin) / cfg.boatLen;
    var h = Math.round(l * 2) / 2, w = Math.floor(h), half = h - w ? " e mezza" : "";
    if (l < 1.25) return "una lunghezza";
    if (l >= 10) return Math.round(l) + " lunghezze";
    return (w === 1 ? "una lunghezza" : w + " lunghezze") + half;
  }
  function tackText(c) {
    var w = who(c), s = w.charAt(0).toUpperCase() + w.slice(1) + ": " + (Math.abs(c.margin) < c.err ? "al pelo" : (c.margin > 0 ? "passi davanti di " : "passi dietro di ") + tackLen(c));
    return s + (c.src === "cam" && !c.known ? ", mure non sicure" : "");
  }
  function tackAsk() {
    var m = M(), S = m.own();
    if (!m.tackCross) return;
    if (!fin(S.lat)) { say("Non ho la nostra posizione."); return; }
    if (!fin(S.twa) || Math.abs(S.twa) >= 90) { say("Siamo in poppa: il calcolo della virata vale di bolina."); return; }
    var L = m.tackCross().filter(function (c) { return c.dist <= 800; }).sort(function (a, b) { return a.dist - b.dist; }).slice(0, 3);
    if (!L.length) { say("Virando non incroci nessuna barca vicina. Inquadrale con la camera, o servono gli AIS."); return; }
    say("Virando. " + L.map(tackText).join(". ") + ".", { flush: true });
  }
  // said by itself: when a tack starts to cross a boat within 400 m ("Puoi virare: passi davanti a ORMA di una lunghezza"),
  // and if it stops crossing within 2 minutes of that call ("Non più: virando passi dietro a ORMA")
  function tackWatch() {
    var m = M(); if (!cfg.tackCall || !m || !m.tackCross || st.cal) return;
    var r = m.cdRem(); if (fin(r) && r > 0) return;                  // before the gun the start calls talk
    var now = Date.now(), tw = st.tw || (st.tw = {}), seen = {};
    m.tackCross().forEach(function (c) {
      if (c.dist > 400) return;
      seen[c.id] = 1;
      var ahead = c.margin > c.err, o = tw[c.id];
      if (!o) { tw[c.id] = { ahead: ahead, call: 0, last: 0, t: now }; return; }
      o.t = now;
      if (ahead && !o.ahead && now - o.call > 60000 && now - o.last > 20000) { o.call = o.last = now; say("Puoi virare. " + tackText(c) + "."); }
      else if (o.call && c.margin < -c.err && now - o.call < 120000) { o.call = 0; o.last = now; say("Non più. Virando, " + tackText(c) + "."); }
      o.ahead = ahead;
    });
    Object.keys(tw).forEach(function (k) { if (!seen[k] && now - tw[k].t > 30000) delete tw[k]; });
  }

  // ---------- guided calibration, before the warning signal ----------
  // Beat 30 s, tack, beat 30 s on the other tack (true wind on each tack), bear away to a reach, luff up.
  // The manoeuvres are measured by the page (calib.js); this says what to do and reads the results.
  function twdNow(sec) { var m = M(); return m.twdMean ? m.twdMean(sec) : NaN; }
  function upwind(S) { return fin(S.twa) && Math.abs(S.twa) >= 25 && Math.abs(S.twa) <= 60; }
  function calibrate() {
    var m = M(); if (!m || !m.calOn) return;
    if (st.cal) { calEnd("Calibrazione interrotta."); return; }
    if (!st.calHooked) { m.calOn(function (x) { if (st.cal && st.cal.onMan) st.cal.onMan(x); }); st.calHooked = true; }
    var c = st.cal = { step: 0, since: 0, t0: Date.now(), res: {}, onMan: null };
    var steps = [
      { say: "Calibrazione. Bolina per trenta secondi.", wait: function (S) { return upwind(S); }, hold: 30,
        done: function (S) { c.res.twd1 = twdNow(25); c.res.side1 = S.twa > 0 ? "dritta" : "sinistra"; } },
      { say: "Vira, ora!", man: "tack" },
      { say: "Bolina, trenta secondi.", wait: function (S) { return upwind(S); }, hold: 30,
        done: function (S) { c.res.twd2 = twdNow(25); } },
      { say: "Poggia al traverso e tieni quindici secondi.", wait: function (S) { return fin(S.twa) && Math.abs(S.twa) >= 75 && Math.abs(S.twa) <= 115; }, hold: 15 },
      { say: "Orza di bolina, ora!", man: "luff" }
    ];
    c.steps = steps;
    function next() {
      if (c.step >= steps.length) { calSummaryV(); return; }
      var p = steps[c.step]; c.since = 0; c.started = Date.now(); say(p.say, { flush: true });
      c.onMan = p.man ? function (x) {
        if (x.type !== p.man || x.t * 1000 < c.started - 5000) return;
        c.res[p.man] = x; x.guided = true;
        say(p.man === "tack" ? "Virata: " + (fin(x.loss) ? "persi " + n1(x.loss) + " secondi, " : "") + n1(x.rate) + " gradi al secondo" + (fin(x.rec) && x.rec < 90 ? ", a velocità in " + x.rec + " secondi" : "") + "."
          : "Orzata: " + n1(x.rate) + " gradi al secondo" + (fin(x.loss) ? (x.loss >= 0 ? ", persi " : ", guadagnati ") + n1(Math.abs(x.loss)) + " secondi sul modello" : "") + ".");
        c.step++; setTimeout(next, 2500);
      } : null;
    }
    c.tick = setInterval(function () {
      if (!st.cal) return;
      var p = steps[c.step], S = M().own(); if (!p) return;
      if (Date.now() - c.started > 240000) { say("Salto questo passo."); c.step++; next(); return; }
      if (p.man) {
        // the measure comes about 30 s after the turn: say so once, so nobody waits in silence
        if (!c.told && Date.now() - c.started > 20000) { c.told = true; say("Misuro, tieni la bolina."); }
        return;
      }
      c.since = p.wait(S) ? c.since + 1 : 0;
      if (c.since >= p.hold) { if (p.done) p.done(S); c.step++; c.told = false; next(); }
    }, 1000);
    next(); state();
  }
  function calSummaryV() {
    var c = st.cal, r = c.res, parts = [];
    if (fin(r.twd1) && fin(r.twd2)) {
      var d = wrap180(r.twd2 - r.twd1); if (r.side1 === "dritta") d = -d;     // starboard minus port
      parts.push(Math.abs(d) < 3 ? "vento vero coerente tra le mure" : "il vento vero cambia di " + Math.round(Math.abs(d)) + " gradi tra le mure: se si ripete, controlla la taratura di bussola e AWA");
    }
    var s = M().calib().sum;
    if (fin(s.luffRate || s.rate)) parts.push("accostata " + n1(fin(s.luffRate) ? s.luffRate : s.rate) + " gradi al secondo");
    if (fin(s.tackLoss)) parts.push("virata " + n1(s.tackLoss) + " secondi");
    if (fin(s.luffLoss)) parts.push("orzata " + n1(s.luffLoss) + " secondi");
    clearInterval(c.tick); c.done = true;
    var txt = parts.join(", ") || "non ho misurato abbastanza";
    say("Calibrazione finita. " + txt.charAt(0).toUpperCase() + txt.slice(1) + ". Di' applica calibrazione per usarla in partenza.");
    st.calAsk = Date.now(); st.cal = null; state();
  }
  // guided speed and compass calibration: steady on one course, then the opposite one, twice. The page pairs the runs (speedcal.js).
  function speedCalibrate() {
    var m = M(); if (!m || !m.speedCal) return;
    if (st.cal) { calEnd("Calibrazione interrotta."); return; }
    var c = st.cal = { step: 0, since: 0, t0: Date.now(), ref: NaN, started: Date.now() }, HOLD = 45;
    var steps = [
      { say: "Calibrazione velocità. Tieni una rotta costante per quarantacinque secondi.", rel: 0 },
      { say: "Ora la rotta opposta: gira di centottanta gradi e tieni costante quarantacinque secondi.", rel: 180 },
      { say: "Di nuovo la prima rotta, quarantacinque secondi.", rel: 0 },
      { say: "E ancora la rotta opposta, quarantacinque secondi.", rel: 180 }
    ];
    function say1() { c.since = 0; c.ref = NaN; c.started = Date.now(); say(steps[c.step].say, { flush: true }); }
    function finish() {
      clearInterval(c.tick);
      // the page closes a run a few seconds after it ends: wait for it, then read the result
      setTimeout(function () {
        var s = M().speedCal(), f2 = function (v) { return (Math.round(v * 100) / 100).toString().replace(".", ","); };
        if (!s || !(s.n >= 1)) say("Calibrazione finita, ma non ho trovato coppie di rotte opposte. Riprova tenendo la rotta più costante.");
        else say("Fattore velocità " + f2(s.factor) + ", bussola " + (s.offset > 0 ? "più " : "meno ") + f2(Math.abs(s.offset)) + " gradi, da " + s.n + (s.n === 1 ? " coppia" : " coppie") + ". " +
          (s.ok ? "Risultato buono. Di' applica velocità per usarlo." : "Non è ancora abbastanza sicuro: non lo applico."));
        st.cal = null; state();
      }, 12000);
    }
    c.tick = setInterval(function () {
      if (!st.cal) return;
      var S = M().own(), p = steps[c.step]; if (!p) return;
      if (Date.now() - c.started > 180000) { say("Salto questo passo."); c.step++; if (c.step >= steps.length) finish(); else say1(); return; }
      if (!fin(S.hdg) || !(S.sog >= 3)) { c.since = 0; return; }
      if (!fin(c.ref)) {
        // first step: any steady course; the others: the first course turned by 180 degrees (or the same again)
        if (c.step === 0) c.ref = S.hdg;
        else { var want = (c.base + p.rel) % 360; if (Math.abs(wrap180(S.hdg - want)) <= 20) c.ref = S.hdg; else { c.since = 0; return; } }
      }
      if (Math.abs(wrap180(S.hdg - c.ref)) > 4) { c.since = 0; c.ref = NaN; if (c.step === 0) c.ref = S.hdg; return; }
      c.since++;
      if (c.since >= HOLD) {
        if (c.step === 0) c.base = c.ref;
        c.step++; if (c.step >= steps.length) finish(); else say1();
      }
    }, 1000);
    say1(); state();
  }
  function speedApplyV() {
    var m = M(); if (!m || !m.speedApply) return;
    var why = m.speedApply();
    say(why ? "Non applico: " + (/too few|scattered/.test(why) ? "coppie poche o troppo disperse." : /no reciprocal/.test(why) ? "non ho misure." : "i valori sono troppo fuori, controlla gli strumenti.") : "Correzione applicata a velocità e bussola.");
  }
  // ---------- conversational assistant (llm.js): a cloud model that asks these read-only tools ----------
  // The key lives only on this device (localStorage, not in the boat profile, not synced, not in the repository).
  function llmKey() { try { return localStorage.getItem("mrv.llmKey") || ""; } catch (e) { return ""; } }
  function llmSetKey(k) { try { if (k) localStorage.setItem("mrv.llmKey", k); else localStorage.removeItem("mrv.llmKey"); } catch (e) {} st.llm = null; }
  function r1(x) { return fin(x) ? Math.round(x * 10) / 10 : null; }
  function llmTools() {
    var T = function (description, run, props) { return { description: description, run: run, input_schema: { type: "object", properties: props || {}, additionalProperties: false } }; };
    return {
      get_boat_state: T("Live instruments: boat speed (bsp_kn), speed over ground, headings, true and apparent wind (tws_kn, twa_deg positive on starboard, twd_deg), heel, polar_pct (boat speed as % of the polar target) and the polar targets upwind and downwind at this wind speed.", function () {
        var m = M(), S = m.own(), pp = m.perfNow(), tg = fin(S.tws) && m.tgt ? m.tgt(S.tws) : null;
        return { bsp_kn: S.bsp, sog_kn: S.sog, cog_deg: S.cog, hdg_deg: S.hdg, tws_kn: S.tws, twa_deg: S.twa, twd_deg: S.twd, aws_kn: S.aws, awa_deg: S.awa, heel_deg: S.heel,
          polar_pct: fin(pp) ? pp * 100 : null, target_upwind: tg ? { twa_deg: tg.up.twa, bsp_kn: tg.up.bsp, vmg_kn: tg.up.vmg } : null, target_downwind: tg ? { twa_deg: tg.dn.twa, bsp_kn: tg.dn.bsp, vmg_kn: tg.dn.vmg } : null };
      }),
      get_wind_trend: T("True wind direction and speed now (last 20 s) and N minutes ago, with the change; use it for shifts and pressure.", function (i) {
        var w = windNow(Math.max(1, Math.min(30, +i.minutes || 5)));
        return { minutes: Math.max(1, Math.min(30, +i.minutes || 5)), twd_now_deg: w.now, twd_then_deg: w.then, twd_change_deg: fin(w.now) && fin(w.then) ? wrap180(w.now - w.then) : null, tws_now_kn: w.tws, tws_then_kn: w.tws0 };
      }, { minutes: { type: "number", description: "how many minutes back, 1 to 30" } }),
      get_start_line: T("Start line and countdown: countdown_s, distance to the line (positive = on the course side, behind the line = negative), seconds to reach the line, favoured end and bias, and the time to the line if luffing or tacking now. Null if no line is set.", function () {
        var m = M(), s = m.startInfo(), cd = m.cdRem(); if (!s) return { countdown_s: cd, line: null };
        return { countdown_s: cd, line_length_m: s.len * 1852, distance_to_line_m: s.d * 1852, seconds_to_line_on_this_course: s.ttl, favoured_end: s.fav || null, bias_deg: s.biasDeg, advantage_m: fin(s.adv) ? s.adv * 1852 : null,
          dist_to_pin_m: s.dPin * 1852, dist_to_boat_end_m: s.dBoat * 1852, luff_to_line_s: s.luff && s.luff.ok ? s.luff.time : null, tack_to_line_s: s.tackUp && s.tackUp.ok ? s.tackUp.time : null };
      }),
      get_laylines: T("Layline to the active mark on each tack: distance (nm), speed (kn), tack penalty (s) already added to time_s, whether overstood (past) or converging (hit).", function () {
        var li = M().layInfo(); if (!li) return null; var o = {};
        ["port", "stbd"].forEach(function (k) { var x = li[k]; o[k] = !x ? null : { mode: x.mode, hit: !!x.hit, past: !!x.past, distance_nm: x.d, speed_kn: x.spd, tack_penalty_s: x.pen || 0, time_s: x.hit && x.spd > 0.3 ? x.d / x.spd * 3600 + (x.pen || 0) : null }; });
        return o;
      }),
      get_active_mark: T("Active course mark: distance (nm), bearing, velocity made good to it (kn).", function () { var m = M(), d = m.dtwBtw(); return { distance_nm: d.d, bearing_deg: d.b, vmc_kn: m.vmc() }; }),
      get_tack_crossings: T("Boats we would cross if we tacked now: seconds to the crossing, margin in metres (positive = we pass ahead), distance in metres, name.", function () {
        return (M().tackCross() || []).slice(0, 6).map(function (c) { return { name: c.name, t_s: c.t, margin_m: c.margin, dist_m: c.dist, bearing_deg: c.brg, src: c.src }; });
      }),
      get_fleet: T("The nearest other boats (AIS and camera): name, distance in metres, bearing from us, course and speed.", function () {
        var m = M(), S = m.own(); if (!fin(S.lat)) return [];
        var kx = 111120 * Math.cos(S.lat * D2R);
        return m.fleetBoats().map(function (b) { var dx = (b.lon - S.lon) * kx, dy = (b.lat - S.lat) * 111120; return { name: b.name, dist_m: Math.hypot(dx, dy), bearing_deg: wrap360(Math.atan2(dx, dy) * R2D), cog_deg: b.cog, sog_kn: b.sog }; })
          .sort(function (a, b) { return a.dist_m - b.dist_m; }).slice(0, 8);
      }),
      get_forecast_wind: T("Wind forecast (from the GRIB file the user loaded) at the boat's position: now, in 1 h and in 3 h, with true wind direction and speed; null where the file does not cover. Also the forecast file's coverage.", function () {
        var m = M(), S = m.own(), now = Date.now(), at = function (h) { var f = fin(S.lat) && m.forecast ? m.forecast(S.lat, S.lon, now + h * 3600000) : null; return f ? { twd_deg: f.twd_deg, tws_kn: f.tws_kn } : null; };
        var i = m.gribInfo ? m.gribInfo() : null; if (!i) return { loaded: false };
        return { loaded: true, now: at(0), in_1h: at(1), in_3h: at(3), file_from: new Date(i.from).toISOString(), file_to: new Date(i.to).toISOString() };
      }),
      get_route: T("The fastest route to the active mark as MaxRace computes it (when the user has the Route layer on): hours to go, arrival time, number of tacks/gybes, distance sailed against direct distance, and which wind it used. Null if no route is on.", function () {
        var r = M().route ? M().route() : null; return r ? { hours: r.hours, arrival: new Date(r.eta).toISOString(), tacks_gybes: r.tacks, sailed_nm: r.sailedNm, direct_nm: r.directNm, wind_used: r.src } : null;
      }),
      get_calibration: T("What MaxRace measured on this boat: turn rate, tack and luff loss in seconds and metres (also by wind band), speed against the polar upwind, speed and compass correction in use.", function () {
        var s = M().calib().sum; return { turn_rate_deg_s: s.rate, tack_loss_s: s.tackLoss, tack_loss_m: s.tackLossM, tack_speed_drop_kn: s.vdrop, luff_loss_s: s.luffLoss, polar_pct_upwind: s.pct, bands: s.bands };
      }),
      get_race_documents: T("Items read from the race documents the user kept (notice of race, sailing instructions): start times, VHF channel, time limits, course notes, each with its source text.", function () {
        var out = []; (M().raceDocs() || []).forEach(function (d) { d.items.forEach(function (x) { if (x.kind !== "mark") out.push({ document: d.name, kind: x.kind, label: x.label, value: x.value, text: x.text }); }); }); return out.slice(0, 30);
      })
    };
  }
  function llmClient() {
    if (!st.llm || st.llmModel !== cfg.llmModel) { st.llmModel = cfg.llmModel; st.llm = window.MRLLM.create({ getKey: llmKey, getModel: function () { return cfg.llmModel || undefined; }, tools: llmTools() }); }
    return st.llm;
  }
  function llmLog(r) {
    var a = load("lat", []); a.push({ t: Date.now(), ms: r.total, apiMs: r.apiMs, rounds: r.rounds }); a = a.slice(-30); save("lat", a);
  }
  // end-to-end: from the question heard (or typed) to the moment the answer is handed to the speech
  function latency() {
    var a = load("lat", []), v = a.map(function (x) { return x.ms; }).sort(function (x, y) { return x - y; });
    return { n: a.length, median: v.length ? v[v.length >> 1] : NaN, p90: v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.9))] : NaN, last: a.length ? a[a.length - 1] : null };
  }
  function llmAnswer(q) {
    if (!window.MRLLM) { say("L'assistente non è caricato."); return; }
    var t0 = st.heardAt && Date.now() - st.heardAt < 15000 ? st.heardAt : Date.now(); st.heardAt = 0;
    return llmClient().ask(q).then(function (r) {
      var txt = r.text || "Non ho una risposta.";
      if (r.unverified.length) txt += " Attenzione: " + (r.unverified.length === 1 ? "il numero " : "i numeri ") + r.unverified.join(", ") + " non risulta dai dati.";
      llmLog({ total: Date.now() - t0, apiMs: r.apiMs, rounds: r.rounds });
      say(txt, { flush: true });
    }).catch(function (e) {
      console.log("[voice] llm error", e && e.code, e && e.message);
      var c = e && e.code;
      if (c === "network" || c === "server") { say("Non riesco a collegarmi all'assistente. Uso i comandi base: puoi chiedere incroci, se viro, vento, linea, boa, layline, velocità."); }
      else say(c === "auth" ? "La chiave dell'assistente non è valida." : c === "rate" ? "Troppe richieste all'assistente, riprova tra poco." : c === "refused" ? "A questo non posso rispondere." : c === "nokey" ? "Manca la chiave dell'assistente nelle impostazioni." : "L'assistente non ha risposto.");
    });
  }
  // from the race documents the user read and kept (never guessed): the VHF channel
  function vhfAsk() {
    var m = M(), docs = m && m.raceDocs ? m.raceDocs() : [], hit = null;
    docs.some(function (d) { return d.items.some(function (x) { if (x.kind === "vhf") { hit = x; return true; } }); });
    say(hit ? "Canale VHF " + hit.value + ", dal documento di regata." : "Non ho un canale VHF: leggi prima il bando o le istruzioni di regata.");
  }
  function calApplyV() {
    var d = M().calApply(); if (st.cal) { clearInterval(st.cal.tick); st.cal = null; }
    say(d.length ? "Applicata: " + d.join(", ").replace(/°\/s/g, " gradi al secondo").replace(/ s\b/g, " secondi").replace(/turn rate/, "accostata").replace(/tack loss/, "virata").replace(/luff loss/, "orzata").replace(/(\d)\.(\d)/g, "$1,$2") + "." : "Non ho ancora misure da applicare.");
  }
  function calEnd(t) { if (st.cal) clearInterval(st.cal.tick); st.cal = null; say(t, { flush: true }); state(); }
  // in the race: the true wind seen on each tack should agree; say it once in a while if it does not
  function twdTackWatch() {
    var m = M(); if (!m || !m.calib) return; var c = m.calib(); if (c.sim) return;
    var s = c.sum; if (!(s.nPairs >= 2) || !(Math.abs(s.twdTack) >= 4) || Date.now() - (st.twdWarn || 0) < 1200000) return;
    st.twdWarn = Date.now();
    say("Attenzione: il vento vero è " + Math.round(Math.abs(s.twdTack)) + " gradi più a " + (s.twdTack > 0 ? "destra" : "sinistra") + " sulle mure a dritta che a sinistra. Probabile taratura degli strumenti.");
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

  setInterval(function () { try { shiftWatch(); twdTackWatch(); } catch (e) {} }, 5000);
  setInterval(function () { try { tackWatch(); } catch (e) {} }, 2000);
  setInterval(function () { try { countdownWatch(); goWatch(); } catch (e) {} }, 250);

  // the earphone stem talks only when turned on (it makes MaxRace the "now playing" app)
  function stemOn(on) { var m = M(); if (m && m.native) m.nat({ cmd: "voiceOn", on: !!on }); }

  window.MRVoice = {
    listen: listen, say: say, answer: answer, goWatch: goWatch, goInfo: goInfo, tackAsk: tackAsk, tackWatch: tackWatch, calibrate: calibrate, cfg: cfg, st: st, stemOn: stemOn, llmSetKey: llmSetKey, llmHasKey: function () { return !!llmKey(); }, latency: latency,
    set: function (k, v) { cfg[k] = v; save(k, v); if (k === "stem") stemOn(v); },
    init: function () { if (cfg.stem) stemOn(true); if (window.MRVoicePack) window.MRVoicePack.load("voicepack/").then(function (j) { if (st.onPack) st.onPack(j); }).catch(function () { if (st.onPack) st.onPack(null); }); }
  };
})();
