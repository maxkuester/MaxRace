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
- [x] Outliers (sensor spikes, bad wind data) rejected — polarlearn.js `plausible()` (ranges, speed vs reference polar), used on live data and CSV

## 3. Learned polars

Polar table: target BSP by TWS and TWA. Bins of 2 kn TWS and 5° TWA; per bin a high percentile of BSP (90th–95th) as the
target plus the sample count; low-confidence bins fall back to the reference polar; optimum upwind and downwind VMG angles
per TWS; updated after each session, keeping history.

- [x] Polar table structure (TWS × TWA) learned from data — polarlearn.js, fed live from calLearn() in maxrace.html (real sources only) and from a race CSV; per boat in localStorage; "Use learned polar" / "Restore previous polar" in Settings. Live path not yet run on a real boat
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
- [x] Coverage view (TWS/TWA bins with data) — Settings > Learned polar, table of samples per bin (plRender() in maxrace.html)

## 7. Conversational race assistant

Online: cloud LLM with tool calling over live MaxRace data, never inventing numbers. Offline fallback: on-device model or
the hard-coded commands. Push-to-talk, short spoken answers, low latency, proactive alerts.

- [~] Internal API exposing live data — window.MRT (own, hist, ais, cam, startInfo, layInfo, perfNow, tackCross, fleetBoats…)
- [x] Speech-to-text and text-to-speech — voice.js + native (iOS SFSpeechRecognizer / AVSpeechSynthesizer, Android)
- [x] Proactive alerts — wind shifts, countdown and burn, "Bolina, ora!", "Puoi virare", TWD by tack
- [~] LLM layer with tool calling; online/offline switching — llm.js (Messages API by plain fetch, tool loop, numbers in the answer checked against the tool results) + 9 read-only tools in voice.js `llmTools()`; Settings > Voice > Race assistant (key on the device only); built-in commands first, assistant for what they do not understand (or for everything, if chosen); offline or server error falls back to the built-in commands. Tested only against a mocked API, never against the real one
- [~] Latency measured end to end — voice.js `latency()` (median, slowest tenth, last) from the question heard/typed to the answer handed to the speech, shown in Settings; not to the first audio, and no real figures yet
- [~] Natural voice — voice pack player (voicepack.js) and generator on the Mac (scripts/voicepack-gen.py); pack not generated yet

## 8. Pre-race research

- [ ] Web search and document download (NoR, SI, amendments) — not done: the user opens the PDF or pastes the text
- [~] PDF parsing of NoR and SI — racedocs.js `extract()` on the text from the app's own PDF reader (Italian/English: positions, warning signal and start times, VHF, protest and race time limits, course types); tested on a synthetic PDF and text, not on a real NoR/SI; scanned PDFs cannot be read; no rounding sides, courses or amendments logic
- [x] Mark import from GPX/KML/coordinates — marksimport.js `parse()` + file picker in Course and marks (GPX wpt/rtept, KML Point/LineString); start line by coordinates and manual marks as before; untested on a real committee file
- [~] Entry list — pasted or CSV, matched to AIS and camera targets
- [x] User confirmation step and offline cache — Course and marks > Race documents: items listed with their source line, positions ticked and confirmed before they become marks; last 6 documents kept in localStorage; voice "che canale VHF" reads the kept channel

## 9. Weather data (GRIB)

- [~] GRIB download and parsing — parsing: grib.js (GRIB1 simple packing; GRIB2 lat/lon grid, packing 5.0/5.2/5.3, U/V or direction/speed at 10 m, bitmap); file opened by the user in Settings > Wind forecast. JPEG2000/PNG/CCSDS packing not read (reported), no Gaussian/rotated grids. Tested only on GRIB files built by the test's own encoder (scripts/test-grib.js), never on a real GRIB file. No download: not done
- [x] Offline cache — the GRIB file is kept in IndexedDB and reloaded at start (tested: survives a page reload)
- [x] Map display with time slider — Wind layer on the map (arrows coloured by speed, knots written), slider over the file's times; checked in a headless browser screenshot
- [~] Forecast vs measured comparison — bias and typical error of direction and speed over the last 30 min at the boat's position (gribCompare()); only the last 30 min, no per-wind-band report

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

- [~] Guided trials workflow — voice-guided routine for turn rate, tack and luff loss, TWD by tack (calib.js, voice.js); speed and compass routine (voice.js `speedCalibrate()`: two reciprocal pairs, 45 s each, says the factor and offset, "applica velocità"); tested with a simulated heading and clock, not on the water
- [x] BSP and compass calibration calculations — speedcal.js, live runs kept in calib.runs, Settings > Speed and compass; synthetic test and CSV check only; no port/starboard split
- [x] Accept/reject and apply corrections — manoeuvre values (Apply) and BSP factor / heading offset (Apply correction, refused unless usable; corr applied in cB()/cH() where NMEA and Signal K values come in, per boat profile)
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
