// MaxRace data server.
// Opens the NMEA 0183 source over TCP or UDP (a browser cannot) and hands each
// sentence to the dashboard page over Server-Sent Events. It also serves the
// page itself, so other devices on the boat network can open the same dash.
//
// Used inside the desktop app (main.js), or on its own:
//   node server.js [--port 8765] [--source tcp:192.168.1.50:10110 | udp::10110]

"use strict";
const http = require("http");
const net = require("net");
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };

function createSource(log) {
  const clients = new Set();
  const status = { connected: false, error: "not configured", lines: 0, source: null };
  let gen = 0, sock = null, timer = null;

  function broadcast(event, data) {
    const msg = event === "message" ? `data: ${data}\n\n` : `event: ${event}\ndata: ${data}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch (e) { clients.delete(res); } }
  }
  function setStatus(connected, error) {
    status.connected = connected; status.error = error;
    broadcast("status", JSON.stringify(status));
  }
  function emitLines(state, chunk) {
    state.buf += chunk.toString("latin1");
    const lines = state.buf.split("\n"); state.buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (line) { status.lines++; broadcast("message", line); }
    }
    if (state.buf.length > 65536) state.buf = "";
  }
  function stop() {
    gen++;
    if (timer) { clearTimeout(timer); timer = null; }
    if (sock) { try { sock.destroy ? sock.destroy() : sock.close(); } catch (e) {} sock = null; }
  }
  function retry(g, proto, host, port, err) {
    if (g !== gen) return;
    log(`${proto.toUpperCase()} ${host || "*"}:${port} - ${err}; retrying in 3 s`);
    setStatus(false, String(err));
    timer = setTimeout(() => { if (g === gen) open(g, proto, host, port); }, 3000);
  }
  function open(g, proto, host, port) {
    const state = { buf: "" };
    if (proto === "tcp") {
      const s = net.connect({ host, port });
      sock = s;
      s.setTimeout(30000);
      s.on("connect", () => { if (g === gen) { setStatus(true, null); log(`connected to TCP ${host}:${port}`); } });
      s.on("data", (d) => { if (g === gen) emitLines(state, d); });
      s.on("timeout", () => s.destroy(new Error("no data for 30 s")));
      let failed = false;
      const fail = (e) => { if (failed) return; failed = true; s.destroy(); retry(g, proto, host, port, e && e.message ? e.message : "connection closed by the source"); };
      s.on("error", fail);
      s.on("close", () => fail(null));
    } else {
      const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sock = s;
      s.on("message", (d, rinfo) => {
        if (g !== gen) return;
        if (host && rinfo.address !== host) return;
        emitLines(state, d.length && d[d.length - 1] === 10 ? d : Buffer.concat([d, Buffer.from("\n")]));
      });
      s.on("error", (e) => { try { s.close(); } catch (x) {} retry(g, proto, host, port, e.message); });
      s.bind(port, () => { if (g === gen) { setStatus(true, null); log(`listening for UDP on port ${port}` + (host ? ` from ${host}` : "")); } });
    }
  }
  function configure(proto, host, port) {
    stop();
    status.source = { proto, host, port };
    setStatus(false, "connecting");
    open(gen, proto, host, port);
  }
  return { clients, status, configure, stop };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

function startServer(opts) {
  const o = Object.assign({ port: 8765, host: "0.0.0.0", root: __dirname, page: "maxrace.html", log: (m) => console.log("[maxrace] " + m) }, opts || {});
  const source = createSource(o.log);

  const json = (res, obj, code) => {
    const body = JSON.stringify(obj);
    res.writeHead(code || 200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p === "/" || p === "/index.html") return sendFile(res, path.join(o.root, o.page));
    if (p.startsWith("/fonts/")) {
      const f = path.normalize(path.join(o.root, p));
      if (!f.startsWith(path.join(o.root, "fonts"))) return json(res, { ok: false, error: "not found" }, 404);
      return sendFile(res, f);
    }
    if (p === "/connect") {
      const proto = (url.searchParams.get("proto") || "tcp").toLowerCase();
      const host = (url.searchParams.get("host") || "").trim();
      const port = parseInt(url.searchParams.get("port") || "0", 10);
      if (proto !== "tcp" && proto !== "udp") return json(res, { ok: false, error: "protocol must be tcp or udp" });
      if (!(port > 0 && port < 65536)) return json(res, { ok: false, error: "port must be between 1 and 65535" });
      if (proto === "tcp" && !host) return json(res, { ok: false, error: "TCP needs the IP address of the source" });
      source.configure(proto, host, port);
      return json(res, { ok: true });
    }
    if (p === "/disconnect") { source.stop(); source.status.connected = false; source.status.error = "stopped"; return json(res, { ok: true }); }
    if (p === "/status") return json(res, source.status);
    if (p === "/info") return json(res, { app: "MaxRace", port: server.address().port, addresses: lanAddresses() });
    if (p === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", Connection: "keep-alive" });
      res.write(`event: status\ndata: ${JSON.stringify(source.status)}\n\n`);
      source.clients.add(res);
      const ka = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch (e) {} }, 15000);
      req.on("close", () => { clearInterval(ka); source.clients.delete(res); });
      return;
    }
    json(res, { ok: false, error: "not found" }, 404);
  });

  function sendFile(res, file) {
    fs.readFile(file, (err, data) => {
      if (err) return json(res, { ok: false, error: "not found" }, 404);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  }

  // try the preferred port first, so the page keeps the same address (and its saved settings)
  return new Promise((resolve, reject) => {
    let port = o.port, tries = 0;
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE" && tries < 20) { tries++; port++; server.listen(port, o.host); }
      else reject(e);
    });
    server.listen(port, o.host, () => resolve({ server, source, port: server.address().port, addresses: lanAddresses() }));
  });
}

module.exports = { startServer, lanAddresses };

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  startServer({ port: parseInt(get("--port") || "8765", 10) }).then(({ source, port, addresses }) => {
    console.log("MaxRace server running. Open the dashboard on the boat network at:");
    for (const a of addresses) console.log(`    http://${a}:${port}`);
    console.log(`    http://localhost:${port}   (on this computer)`);
    const src = get("--source");
    if (src) {
      const [proto, host, port2] = src.split(":");
      source.configure(proto.toLowerCase(), host, parseInt(port2, 10));
    }
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
