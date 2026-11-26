# MaxRace – Performance Learning Spec (Polars & Turn Rate)

Goal: MaxRace learns the boat's real performance from its own H5000 data, instead of relying only on theoretical polars.
This file is both the spec of what to build and the checklist of what exists. A daily read-only agent compares the
repository with it and reports progress; it does not edit this file. Status marks: `[x]` done, `[~]` partial, `[ ]` missing.

Status as checked on 19 Nov 2026 (branch `feat/targets-map`).

## 1. Data ingestion (prerequisite)

Required fields from the H5000 TCP stream, with timestamps: BSP, SOG, HDG, COG, AWA, AWS, TWA, TWS, TWD, heel, rate of
turn (or derived from heading), rudder angle if available.

- [~] All fields parsed and timestamped — MWV, VHW, HDG/HDM/HDT, VTG, RMC, GGA, MWD, XDR (heel), VWR/VWT in `parseNMEA()` (maxrace.html); no ROT, no RSA (rudder)
- [~] Data logged to disk per session (raw + cleaned) — raw NMEA log by the app (RaceLog.swift / RaceLog.java); CSV, GPX and report at the finish; no separate cleaned file per session
- [x] Logging continues if the UI is closed or the connection drops briefly — native log, Android foreground service
- [x] One consistent clock source — epoch ms of the phone on every line

## 2. Data cleaning and steady-state filter

Steady-state criteria (tunable): heading change below a threshold over a rolling window (10–30 s), TWS and TWA variation
within limits, no tack or gybe in the window, BSP not accelerating significantly.

- [~] Steady-state detector — calib.js: manoeuvre detection and steady beats (≥ 30 s, TWA 25–60°); not for all points of sail
- [x] Thresholds configurable, not hard-coded — `DEFAULTS` + options in polarlearn.js `steady()`
- [~] Manoeuvre periods excluded from polar learning — no polar learning yet
- [~] Outliers (sensor spikes, bad wind data) rejected — polarlearn.js `plausible()` (ranges, speed vs reference polar); not wired to live data

## 3. Learned polars

Polar table: target BSP by TWS and TWA. Bins of 2 kn TWS and 5° TWA; per bin a high percentile of BSP (90th–95th) as the
target plus the sample count; low-confidence bins fall back to the reference polar; optimum upwind and downwind VMG angles
per TWS; updated after each session, keeping history.

- [~] Polar table structure (TWS × TWA) learned from data — polarlearn.js `learn()`/`table()`/`vmgAngles()`, CLI scripts/polar-learn.js; not yet fed from the app's saved races, no UI
- [x] Percentile-based targets — `table()`, 90th percentile by default, fallback to the reference polar
- [x] Sample count and confidence per bin — `n`, `conf`, `source` in `table()`
- [x] Reference polar — ORC certificate PDF, Expedition file or table import
- [x] Target VMG angles — `targets(tws)` in maxrace.html
- [x] Live polar % (BSP vs target)

## 4. Manoeuvre model (tacks, gybes, turn rate)

Detect each tack and gybe; measure turn rate profile, total heading change and duration, speed loss (minimum BSP vs entry
BSP), recovery time to ~95% of target, distance lost vs sailing on (metres). Store per manoeuvre with TWS, sea state, crew.

- [x] Automatic tack detection — calib.js (tack, gybe, luff, bear-away)
- [x] Turn rate (derived from heading)
- [x] Speed loss and recovery — calib.js `measure()`: seconds lost (`loss`), lowest BSP and drop from entry (`vmin`, `vdrop`), recovery to 95% (`rec`)
- [x] Distance lost per manoeuvre in metres — calib.js `measure()` `lossM` (tacks and luffs ending close-hauled; gybes not)
- [x] Results averaged by wind band — calib.js `summarize()` `bands` (TWS 0–8, 8–12, 12–16, 16+ kn), shown in the calibration panel
- [~] Gybes measured as well as detected

## 5. Using the models in race logic

- [~] Race calculations read the learned model — start ("Bolina, ora!") and "se viro?" use the calibrated turn rate and tack loss; laylines do not
- [~] Manoeuvre cost feeds into layline and routing decisions — layline "after tack" time includes `tackCost(tws)` (band median, else profile value); no routing yet
- [x] Tactical call "tack now?" includes the tack cost — tackCross() in maxrace.html, voice "se viro?"
- [ ] Opponent speed and angles compared against our polars

## 6. Validation

- [~] Session replay mode — the app's race log replays through the live parsing
- [ ] Prediction error report per wind band
- [~] Coverage view (TWS/TWA bins with data) — data from polarlearn.js `coverage()`; no screen yet

## 7. Conversational race assistant

Online: cloud LLM with tool calling over live MaxRace data, never inventing numbers. Offline fallback: on-device model or
the hard-coded commands. Push-to-talk, short spoken answers, low latency, proactive alerts.

- [~] Internal API exposing live data — window.MRT (own, hist, ais, cam, startInfo, layInfo, perfNow, tackCross, fleetBoats…)
- [x] Speech-to-text and text-to-speech — voice.js + native (iOS SFSpeechRecognizer / AVSpeechSynthesizer, Android)
- [x] Proactive alerts — wind shifts, countdown and burn, "Bolina, ora!", "Puoi virare", TWD by tack
- [ ] LLM layer with tool calling; online/offline switching
- [ ] Latency measured end to end
- [~] Natural voice — voice pack player (voicepack.js) and generator on the Mac (scripts/voicepack-gen.py); pack not generated yet

## 8. Pre-race research

- [ ] Web search and document download (NoR, SI, amendments)
- [ ] PDF parsing of NoR and SI
- [x] Mark import from GPX/KML/coordinates — marksimport.js `parse()` + file picker in Course and marks (GPX wpt/rtept, KML Point/LineString); start line by coordinates and manual marks as before; untested on a real committee file
- [~] Entry list — pasted or CSV, matched to AIS and camera targets
- [ ] User confirmation step and offline cache

## 9. Weather data (GRIB)

- [ ] GRIB download and parsing
- [ ] Offline cache
- [ ] Map display with time slider
- [ ] Forecast vs measured comparison

## 10. Offshore routing

- [ ] Isochrone routing engine
- [ ] Land and exclusion zone avoidance
- [ ] Uses learned polars
- [ ] Re-routing on new data
- [ ] Multi-model comparison

## 11. Advanced routing tools

- [ ] Ensemble routing
- [ ] Departure planning
- [ ] Measured-wind bias correction
- [ ] Sail crossover charts

## 12. Calibration trials mode

One-off: masthead alignment (AWA offset), compass deviation table. Daily: BSP calibration by reciprocal runs (port and
starboard factors), compass offset (HDG vs COG in slack water), TWD stability through tacks; accept/reject, history,
flag uncalibrated data, drift detection. Experiment: wind shear estimated from tack-to-tack asymmetry, validated on logs.

- [~] Guided trials workflow — voice-guided routine for turn rate, tack and luff loss, TWD by tack (calib.js, voice.js)
- [~] BSP and compass calibration calculations — speedcal.js (reciprocal runs: BSP factor, HDG-vs-COG offset, current along track), CLI scripts/speedcal-log.js; synthetic test only, not in the app, no port/starboard split, nothing applied to the data
- [~] Accept/reject and apply corrections — "Apply" for manoeuvre values only
- [ ] Calibration history and data flagging
- [~] Drift detection — TWD-by-tack warning during the race
- [ ] Shear estimator tested on historical logs

## Open questions

- Which reference polar to start from (ORC certificate, designer polar, or none)
- Whether to separate models by sail configuration (jib vs genoa, spinnaker vs gennaker)
- How to handle current: learn on BSP (through water) rather than SOG

## Suggested order

1. Learned polars with the steady-state filter and the coverage view (sections 2, 3, 6)
2. Manoeuvre cost in metres and by wind band, used in laylines (sections 4, 5)
3. Speed calibration, mark import (GPX/KML), race documents (sections 12, 8)
4. GRIB, routing and the LLM assistant (sections 7, 9–11)
