// receives the tracks of a video from the demo page and writes them to tracks-<name>.json (local helper)
const http = require("http"), fs = require("fs"), path = require("path");
http.createServer((q, s) => {
  s.setHeader("Access-Control-Allow-Origin", "*");
  if (q.method !== "POST") return s.end("ok");
  const name = (new URL(q.url, "http://x").searchParams.get("name") || "x").replace(/[^\w-]/g, "");
  let b = ""; q.on("data", (c) => b += c); q.on("end", () => { fs.writeFileSync(path.join(__dirname, "tracks-" + name + ".json"), b); s.end("saved " + b.length); });
}).listen(8791, "127.0.0.1");
