// Finds the boat's instrument data on the Wi-Fi, for someone who does not know the gateway's IP, port or protocol.
// Tries every address of the local network (/24) on the ports NMEA gateways use, over TCP, and listens for UDP
// broadcasts at the same time. Each answer is read and recognised: NMEA 0183 (what MaxRace reads), AIS only,
// NMEA 2000 in a raw form (MaxRace needs 0183), Signal K, or just an open port that sends nothing.
//
//   const scan = require("./scan"); scan.start(); scan.state() -> {running, done, total, net, found: [...]}
//
// The same rules are in the iPhone and Android apps (MaxRacePlugin), so every MaxRace finds the same sources.
"use strict";
const net = require("net");
const dgram = require("dgram");
const os = require("os");

// most likely first, so the usual gateways show up in the first seconds:
// 10110 NMEA 0183 standard (B&G, Raymarine, Garmin, iKommunicate, Quark-elec), 2000 Digital Yacht / Quark-elec,
// 1456/1457 Yacht Devices, 60001/60002 Actisense W2K-1, 39150 Vesper AIS, 3000 Signal K, then others seen on boats
const TCP_PORTS = [10110, 2000, 1456, 60001, 39150, 3000, 2002, 1457, 60002, 2001, 5000, 5001, 4000, 8888, 6000, 2947, 23];
const UDP_PORTS = [10110, 2000, 1456, 1457, 2002, 60002, 5000, 6000];
const CONNECT_MS = 800, LISTEN_MS = 2500, PARALLEL = 96;

// what a few kilobytes from a source are, and in words for the list
function classify(text) {
  const types = new Set();
  let n0183 = 0, m;
  const re = /[$!]([A-Z]{2})([A-Z]{3}),/g;
  while ((m = re.exec(text))) { n0183++; types.add(m[2]); }
  const has = (...k) => k.some((x) => types.has(x));
  const what = [];
  if (has("MWV", "MWD", "VWR", "VWT")) what.push("wind");
  if (has("HDT", "HDG", "HDM")) what.push("heading");
  if (has("VHW")) what.push("boat speed");
  if (has("RMC", "GGA", "GLL", "VTG")) what.push("GPS");
  if (has("DPT", "DBT")) what.push("depth");
  if (has("VDM", "VDO")) what.push("AIS");
  if (has("PCDIN")) what.push("NMEA 2000 inside 0183");
  if (n0183 >= 2) {
    const inst = has("MWV", "MWD", "HDT", "HDG", "HDM", "VHW");
    return { kind: inst ? "nmea" : what.length === 1 && what[0] === "AIS" ? "ais" : "nmea", what, types: [...types].sort(), score: (inst ? 100 : 40) + what.length * 5 + Math.min(n0183, 20) };
  }
  if (/\d\d:\d\d:\d\d\.\d{3} [RT] [0-9A-F]{8}/.test(text)) return { kind: "n2k", what: ["NMEA 2000 (raw)"], types: [], score: 10 };
  if (/signalk-ws|"signalk"|signalk-http/i.test(text)) return { kind: "signalk", what: ["Signal K"], types: [], score: 30 };
  return null;
}

// the networks to look at: every IPv4 Wi-Fi/Ethernet address this computer has, as /24
function networks() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || /^169\.254\./.test(a.address) || /^(utun|awdl|llw|bridge|vmnet|docker)/.test(name)) continue;
      const p = a.address.split(".").map(Number);
      out.push({ ip: a.address, base: p.slice(0, 3).join("."), name });
    }
  }
  const seen = new Set();
  return out.filter((n) => !seen.has(n.base) && seen.add(n.base)).slice(0, 2);
}

let st = { running: false, done: 0, total: 0, net: "", found: [], error: null };
let gen = 0, socks = [];

function add(f) {
  const k = f.proto + " " + f.host + ":" + f.port;
  const i = st.found.findIndex((x) => x.proto + " " + x.host + ":" + x.port === k);
  if (i >= 0) { if ((f.score || 0) > (st.found[i].score || 0)) st.found[i] = f; }
  else st.found.push(f);
  st.found.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function probeTcp(host, port, g) {
  return new Promise((done) => {
    let data = "", opened = false, fin = false;
    const s = new net.Socket();
    const end = () => {
      if (fin) return; fin = true; s.destroy();
      if (g !== gen || !opened) return done();
      const c = classify(data);
      if (c) add(Object.assign({ proto: "tcp", host, port, sample: data.split(/\r?\n/).find((l) => /^[$!]/.test(l)) || "" }, c));
      else add({ proto: "tcp", host, port, kind: "open", what: [], types: [], score: 1, sample: "" });
      done();
    };
    s.setTimeout(CONNECT_MS);
    s.on("timeout", () => { if (!opened) end(); });
    s.on("error", end);
    s.on("close", end);
    s.on("data", (b) => { data += b.toString("latin1"); if (data.length > 4096) end(); });
    s.connect(port, host, () => {
      opened = true; s.setTimeout(0);
      if (port === 3000 || port === 80) s.write("GET /signalk HTTP/1.0\r\nHost: " + host + "\r\n\r\n");
      setTimeout(end, LISTEN_MS);
    });
  });
}

function start() {
  const g = ++gen;
  const nets = networks();
  st = { running: true, done: 0, total: 0, net: nets.map((n) => n.base + ".0/24").join(", "), ip: nets.map((n) => n.ip).join(", "), found: [], error: null };
  if (!nets.length) { st.running = false; st.error = "This computer is not on a Wi-Fi or Ethernet network."; return st; }
  // UDP: gateways that broadcast; listen on their ports for the whole search
  socks.forEach((u) => { try { u.close(); } catch (e) {} });
  socks = [];
  for (const port of UDP_PORTS) {
    try {
      const u = dgram.createSocket({ type: "udp4", reuseAddr: true });
      u.on("error", () => { try { u.close(); } catch (e) {} });
      u.on("message", (b, r) => {
        if (g !== gen) return;
        const txt = b.toString("latin1"), c = classify(txt + "\n" + txt);
        if (c) add(Object.assign({ proto: "udp", host: r.address, port, sample: txt.split(/\r?\n/)[0] }, c));
      });
      u.bind(port);
      socks.push(u);
    } catch (e) {}
  }
  // TCP: every address, port by port in order of likelihood
  const jobs = [];
  for (const port of TCP_PORTS) for (const n of nets) for (let i = 1; i < 255; i++) jobs.push([n.base + "." + i, port]);
  st.total = jobs.length;
  let k = 0;
  const worker = () => {
    if (g !== gen || k >= jobs.length) return Promise.resolve();
    const [h, p] = jobs[k++];
    return probeTcp(h, p, g).then(() => { if (g === gen) st.done++; return worker(); });
  };
  Promise.all(Array.from({ length: PARALLEL }, worker)).then(() => {
    if (g !== gen) return;
    setTimeout(() => {                                   // a last moment for slow UDP broadcasters
      socks.forEach((u) => { try { u.close(); } catch (e) {} });
      if (g === gen) st.running = false;
    }, 1500);
  });
  return st;
}
function stop() { gen++; st.running = false; socks.forEach((u) => { try { u.close(); } catch (e) {} }); socks = []; }
function state() { return st; }

module.exports = { start, stop, state, classify };
