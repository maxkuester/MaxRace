# Demo tools (macOS, offline)

Build the MaxRace target demo videos from a phone video. Run with `swift <file>.swift` (Xcode command line tools) or `node`.

1. `allframes.swift <video> <outdir> 0.3333 <prefix>` — frames at 3 per second plus `frames.json`.
2. Open `../tracker.html?frames=<prefix>/frames.json` (served next to the frames) with the MaxRace server running; it finds the boats and, with `save-server.js` running, the page can POST its tracks to `tracks-<name>.json`.
3. `yaw.swift <video>` — how much the phone turns between frames (stdout JSON), for `scripts/phone-compass-sim.js --yaw`.
4. `render.swift <video> <tracks.json> <out.mp4> hdg= twd= twa= bsp= leg=up|down tack=port|stbd compass=<compass.json> ladder=parity camh=2.0 bow=0 [exclude=1,4]` — the demo video: target boxes and lead on the ladder, parity line, wind-up radar section.
5. `sharp.swift` / `enhance.swift` — sharpest frame of a region, and backlight recovery (reading the mast displays).

These are for demos only: live, the phone compass and the H5000 give heading, TWD and camera direction on every frame.

"Se viro?" demo, from a target demo video already rendered (when the original video is gone):
6. `labels-ocr.swift <demo.mp4> labels.json` — reads the drawn labels ("T3 · 98 m · 142°", lead) 5 times a second.
7. `node tack-margin.js` (in the folder of labels.json; set hdg/twd/beat/bsp/loss inside) — the tack margin of each boat, same geometry as tackCross() in the app.
8. `tack-overlay.swift <demo.mp4> labels-m.json answer.wav <out.mp4>` — draws "↻ se viri −2,5L" beside each label, the question and the answer, and adds the voice.
