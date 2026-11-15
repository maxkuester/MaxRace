// Downloads the boat detector for the Targets camera at build time (TensorFlow.js, COCO-SSD and its lite model,
// about 19 MB), so the installed app finds boats offline at sea. Skips files already there.
"use strict";
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "vendor");
const MODEL = "https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/";
const FILES = [
  ["https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js", "tf.min.js"],
  ["https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js", "coco-ssd.min.js"],
  [MODEL + "model.json", "models/ssdlite_mobilenet_v2/model.json"],
  ...[1, 2, 3, 4, 5].map((i) => [MODEL + `group1-shard${i}of5`, `models/ssdlite_mobilenet_v2/group1-shard${i}of5`]),
];

(async () => {
  let got = 0;
  for (const [url, name] of FILES) {
    const f = path.join(OUT, name);
    if (fs.existsSync(f) && fs.statSync(f).size > 0) continue;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      got++;
    } catch (e) {
      console.warn(`vendor: could not download ${name} (${e.message}); Targets will not find boats without it`);
    }
  }
  console.log(`vendor: boat detector ready (${got} file${got === 1 ? "" : "s"} downloaded)`);
})();
