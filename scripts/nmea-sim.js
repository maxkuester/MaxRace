// NMEA 0183 simulator over TCP: stands in for the boat gateway (B&G H5000) so MaxRace can be tested at home.
// By default a Swan 65 sails upwind off Santa Margherita, tacking every 90 s, in an oscillating 12-16 kn breeze.
//
//   node scripts/nmea-sim.js [--port 10110] [--boat swan65|cape31] [--leg up|down] [--tack stbd|port]
//                            [--twd 220] [--tws 14] [--twa 42] [--bsp 8.3] [--tack-every 90 | --no-tack]
//                            [--lat 44.32 --lon 9.23]
//
// --boat sets the typical angle, speed and heel for the leg (--twa and --bsp still override them):
//   swan65 upwind 42 deg 8.3 kn, downwind 150 deg 9.5 kn; cape31 upwind 39 deg 7.4 kn, downwind with the gennaker 145 deg 12 kn.
// --leg down sails downwind; "tack" then means the gybe (port = wind from the port side) and the turns are gybes.
//
// The videos of 16 Oct 2026 off Saint-Tropez, Cape 31 in a westerly:
//   17:33 upwind, port tack:      node scripts/nmea-sim.js --boat cape31 --twd 270 --tack port --no-tack --lat 43.2533 --lon 6.7382
//   16:58 upwind, starboard tack: node scripts/nmea-sim.js --boat cape31 --twd 270 --tack stbd --no-tack --lat 43.2443 --lon 6.7377
//   17:49 downwind, gennaker, port gybe:
//                                 node scripts/nmea-sim.js --boat cape31 --leg down --twd 270 --tack port --no-tack --lat 43.2498 --lon 6.7348
//
// Then, in MaxRace on a phone on the same Wi-Fi: Settings › Data source › NMEA, TCP, IP of this computer, port 10110.
// Rates like a typical instrument system: heading, boat speed and wind 10 Hz; heel 2 Hz; GPS and true wind direction 1 Hz.
"use strict";
const net = require("net");
const os = require("os");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); const v = i >= 0 ? parseFloat(args[i + 1]) : NaN; return isFinite(v) ? v : d; };
const PORT = opt("port", 10110);
const val = (k) => { const i = args.indexOf("--" + k); return i >= 0 ? String(args[i + 1] || "").toLowerCase() : ""; };
const DOWN = val("leg") === "down";
const BOATS = {
  swan65: { up: { twa: 42, bsp: 8.3, heel: 18, leeway: 3 }, down: { twa: 150, bsp: 9.5, heel: 5, leeway: 0 } },
  cape31: { up: { twa: 39, bsp: 7.4, heel: 20, leeway: 3 }, down: { twa: 145, bsp: 12.0, heel: 6, leeway: 0 } },
};
const BOAT = BOATS[val("boat")] ? val("boat") : "swan65", P0 = BOATS[BOAT][DOWN ? "down" : "up"];
const TWD0 = opt("twd", 220), TWS0 = opt("tws", 14), TWA0 = Math.abs(opt("twa", P0.twa)), BSP0 = opt("bsp", P0.bsp);
const TACK_EVERY = args.includes("--no-tack") ? Infinity : opt("tack-every", 90);
const START_TACK = (args[args.indexOf("--tack") + 1] || "") === "port" && args.includes("--tack") ? -1 : 1;   // +1 starboard, -1 port
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrap360 = (a) => ((a % 360) + 360) % 360;
const wrap180 = (a) => { a = wrap360(a); return a > 180 ? a - 360 : a; };

// ---- the boat and the wind ----
const st = { lat: opt("lat", 44.3200), lon: opt("lon", 9.2300), hdg: 0, bsp: BSP0 * 0.9, cog: 0, sog: 0, twd: TWD0, tws: TWS0, twa: TWA0, awa: 0, aws: 0, heel: 0, tack: START_TACK };
const t0 = Date.now();
let lastTack = -1000, turning = null;

function step(dt) {
  const t = (Date.now() - t0) / 1000;
  // wind: 6-minute oscillation of +-6 deg, slow pressure changes of +-2 kn, a little noise
  st.twd = wrap360(TWD0 + 6 * Math.sin(2 * Math.PI * t / 360) + (Math.random() - 0.5) * 1.5);
  st.tws = TWS0 + 2 * Math.sin(2 * Math.PI * t / 540) + (Math.random() - 0.5) * 0.6;
  // tack every TACK_EVERY s: the heading turns through the wind at about 6 deg/s
  if (!turning && t > 5 && t - Math.max(lastTack, 0) > TACK_EVERY) { turning = { from: st.tack }; lastTack = t; }
  let twa;
  if (turning) {
    // a tack turns through the wind in 14 s, a gybe through dead downwind in 8 s
    const p = Math.min(1, (t - lastTack) / (DOWN ? 8 : 14));
    twa = DOWN ? wrap180(turning.from * (TWA0 + (360 - 2 * TWA0) * p)) : TWA0 * turning.from * (1 - 2 * p);
    if (p >= 1) { st.tack = -turning.from; turning = null; }
  } else twa = TWA0 * st.tack + (Math.random() - 0.5) * 2;
  st.twa = twa;
  st.hdg = wrap360(st.twd - twa);
  // speed: 8.3 kn close-hauled, slower through the tack, recovering after it
  const since = t - lastTack;
  const target = BSP0 * (0.94 + 0.06 * Math.min(1, st.tws / TWS0));
  const turn = DOWN ? 8 : 14, want = turning ? target * (DOWN ? 0.7 : 0.55) : since < turn + 26 ? target * ((DOWN ? 0.7 : 0.55) + (DOWN ? 0.3 : 0.45) * Math.min(1, Math.max(0, since - turn) / 26)) : target;
  st.bsp += (Math.max(0, want) - st.bsp) * Math.min(1, dt * 0.6);
  st.bsp = Math.max(0, st.bsp + (Math.random() - 0.5) * 0.05);
  // a little leeway and no current: COG = heading + 3 deg to leeward
  st.cog = wrap360(st.hdg + (twa > 0 ? P0.leeway : -P0.leeway));
  st.sog = st.bsp;
  st.lat += st.sog * Math.cos(st.cog * D2R) / 60 / 3600 * dt;
  st.lon += st.sog * Math.sin(st.cog * D2R) / 60 / 3600 * dt / Math.cos(st.lat * D2R);
  // apparent wind from true wind and boat speed
  const wx = st.tws * Math.sin(twa * D2R), wy = st.tws * Math.cos(twa * D2R) + st.bsp;
  st.aws = Math.hypot(wx, wy);
  st.awa = Math.atan2(wx, wy) * R2D;
  st.heel = (turning ? 3 : P0.heel * Math.min(1, st.tws / 14)) * (twa > 0 ? -1 : 1) + (Math.random() - 0.5) * 1.5;
}

// ---- sentences ----
function nmea(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return "$" + body + "*" + c.toString(16).toUpperCase().padStart(2, "0") + "\r\n";
}
const f1 = (x) => x.toFixed(1);
function latStr(v) { const a = Math.abs(v), d = Math.floor(a); return String(d).padStart(2, "0") + ((a - d) * 60).toFixed(4).padStart(7, "0") + "," + (v >= 0 ? "N" : "S"); }
function lonStr(v) { const a = Math.abs(v), d = Math.floor(a); return String(d).padStart(3, "0") + ((a - d) * 60).toFixed(4).padStart(7, "0") + "," + (v >= 0 ? "E" : "W"); }
function utc() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return { time: p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "." + String(Math.floor(d.getUTCMilliseconds() / 10)).padStart(2, "0"),
           date: p(d.getUTCDate()) + p(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(2) };
}
const fast = () => [
  nmea(`IIHDT,${f1(st.hdg)},T`),
  nmea(`IIHDG,${f1(wrap360(st.hdg - 2.5))},,,2.5,E`),
  nmea(`IIVHW,${f1(st.hdg)},T,${f1(wrap360(st.hdg - 2.5))},M,${st.bsp.toFixed(2)},N,${(st.bsp * 1.852).toFixed(2)},K`),
  nmea(`IIMWV,${f1(wrap360(st.awa))},R,${f1(st.aws)},N,A`),
  nmea(`IIMWV,${f1(wrap360(st.twa))},T,${f1(st.tws)},N,A`),
];
const medium = () => [nmea(`IIXDR,A,${f1(st.heel)},D,ROLL`)];
const slow = () => {
  const u = utc();
  return [
    nmea(`GPRMC,${u.time},A,${latStr(st.lat)},${lonStr(st.lon)},${st.sog.toFixed(2)},${f1(st.cog)},${u.date},2.5,E,A`),
    nmea(`GPGGA,${u.time},${latStr(st.lat)},${lonStr(st.lon)},1,12,0.7,3.0,M,48.0,M,,`),
    nmea(`GPVTG,${f1(st.cog)},T,${f1(wrap360(st.cog - 2.5))},M,${st.sog.toFixed(2)},N,${(st.sog * 1.852).toFixed(2)},K,A`),
    nmea(`IIMWD,${f1(st.twd)},T,${f1(wrap360(st.twd - 2.5))},M,${f1(st.tws)},N,${(st.tws * 0.514444).toFixed(1)},M`),
  ];
};

// ---- server ----
const clients = new Set();
const server = net.createServer((sock) => {
  const who = sock.remoteAddress + ":" + sock.remotePort;
  clients.add(sock);
  console.log(`connected: ${who} (${clients.size} connected)`);
  sock.on("error", () => {});
  sock.on("close", () => { clients.delete(sock); console.log(`disconnected: ${who} (${clients.size} connected)`); });
});
const send = (lines) => { const s = lines.join(""); for (const c of clients) c.write(s); };

let tick = 0, last = Date.now();
setInterval(() => {
  const now = Date.now();
  step((now - last) / 1000);
  last = now;
  send(fast());
  if (tick % 5 === 0) send(medium());
  if (tick % 10 === 0) send(slow());
  tick++;
}, 100);
setInterval(() => {
  console.log(`HDG ${st.hdg.toFixed(0).padStart(3)}  BSP ${st.bsp.toFixed(1)}  TWA ${st.twa.toFixed(0).padStart(4)}  TWS ${st.tws.toFixed(1)}  TWD ${st.twd.toFixed(0)}  heel ${st.heel.toFixed(0)}   ${clients.size} connected`);
}, 5000);

server.on("error", (e) => { console.error("Cannot open port " + PORT + ": " + e.message); process.exit(1); });
server.listen(PORT, "0.0.0.0", () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) ips.push(a.address);
  console.log(`NMEA simulator on TCP port ${PORT}. In MaxRace choose NMEA, TCP, and one of these IP addresses:`);
  for (const ip of ips) console.log("    " + ip + (ip.startsWith("172.20.10.") ? "   (iPhone hotspot)" : ""));
  if (!ips.length) console.log("    (no network: connect this computer to the Wi-Fi first)");
  console.log(`${BOAT === "cape31" ? "Cape 31" : "Swan 65"} ${DOWN ? "downwind" : "upwind"}, ${BSP0} kn. Wind ${TWD0} deg ${TWS0} kn, ${START_TACK > 0 ? "starboard" : "port"} ${DOWN ? "gybe" : "tack"}, ${TWA0} deg to the wind, ` +
    (TACK_EVERY === Infinity ? (DOWN ? "no gybes" : "no tacks") : `${DOWN ? "gybing" : "tacking"} every ${TACK_EVERY} s`) + `, from ${st.lat.toFixed(4)} ${st.lon.toFixed(4)}.`);
  console.log("The phone must be on the same Wi-Fi. Ctrl-C stops the simulator.");
});
