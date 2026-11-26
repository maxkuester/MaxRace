// Puts the dashboard into native/www, the folder Capacitor copies into the iPhone and Android apps.
// Run by "npm run cap:sync"; the fonts come from scripts/fetch-fonts.js when it has run before.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = path.join(root, "native", "www");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, "maxrace.html"), path.join(out, "index.html"));
fs.copyFileSync(path.join(root, "build", "icon.png"), path.join(out, "icon.png"));
fs.copyFileSync(path.join(root, "targets.js"), path.join(out, "targets.js"));
fs.copyFileSync(path.join(root, "voice.js"), path.join(out, "voice.js"));
fs.copyFileSync(path.join(root, "calib.js"), path.join(out, "calib.js"));
fs.copyFileSync(path.join(root, "marksimport.js"), path.join(out, "marksimport.js"));
fs.copyFileSync(path.join(root, "polarlearn.js"), path.join(out, "polarlearn.js"));
fs.copyFileSync(path.join(root, "speedcal.js"), path.join(out, "speedcal.js"));
fs.copyFileSync(path.join(root, "voicepack.js"), path.join(out, "voicepack.js"));
// the tactician's own voice, made on this Mac (scripts/voicepack-gen.py); not in git, so CI builds go without it
const pack = path.join(root, "voicepack");
if (fs.existsSync(path.join(pack, "index.json"))) fs.cpSync(pack, path.join(out, "voicepack"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "target-tack.js"), path.join(out, "target-tack.js"));
const vendor = path.join(root, "vendor");
if (fs.existsSync(vendor)) fs.cpSync(vendor, path.join(out, "vendor"), { recursive: true });
else console.warn("no vendor/ (boat detector): run node scripts/fetch-vendor.js first, or Targets will not find boats");
const fonts = path.join(root, "fonts");
if (fs.existsSync(fonts)) fs.cpSync(fonts, path.join(out, "fonts"), { recursive: true });
console.log("native/www ready" + (fs.existsSync(fonts) ? " (with offline fonts)" : " (no offline fonts: run npm run fonts first)"));
