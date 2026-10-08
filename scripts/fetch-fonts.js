// Downloads the dashboard fonts at build time so the installed app works offline at sea.
// If there is no internet the build still succeeds and the app falls back to system fonts.
"use strict";
const fs = require("fs");
const path = require("path");

const CSS_URL = "https://fonts.googleapis.com/css2?family=B612:wght@400;700&family=Oxanium:wght@600;700&family=Chakra+Petch:wght@600;700&family=Share+Tech+Mono&family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&display=swap";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT = path.join(__dirname, "..", "fonts");

(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const css = await (await fetch(CSS_URL, { headers: { "User-Agent": UA } })).text();
    if (!/@font-face/.test(css)) throw new Error("unexpected answer from Google Fonts");
    let n = 0, out = css;
    const urls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2/g) || [])];
    for (const u of urls) {
      const name = "f" + (n++) + ".woff2";
      const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
      fs.writeFileSync(path.join(OUT, name), buf);
      out = out.split(u).join(name);
    }
    fs.writeFileSync(path.join(OUT, "fonts.css"), out);
    console.log(`fonts: ${urls.length} files saved for offline use`);
  } catch (e) {
    console.warn("fonts: could not download (" + e.message + "); the app will use system fonts offline");
  }
})();
