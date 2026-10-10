# MaxRace

Sailing race dashboard as a desktop program: instruments, tactical map with course and AIS, start line mode.
Everything runs inside the program. It opens the NMEA 0183 source (TCP or UDP) itself, so no separate bridge is needed.

## Use

1. Double-click `MaxRace-Setup.exe`. It installs in a few seconds, puts the icon on the desktop and opens MaxRace.
2. The first screen asks only for the IP address and port of your NMEA gateway or instrument system → **Connect**. (No instruments at hand: "try the simulator".)
3. From then on, just open the icon: MaxRace remembers the source and reconnects by itself. To change it later: Settings → Data source.

- **F11** (Windows) or **Ctrl+Cmd+F** (Mac): full screen. **Esc** leaves full screen.
- Tablets and phones on the same network can open the same dash: the address is shown in Settings under the NMEA fields, and in Help → "Open on a tablet or phone…". The first time, Windows asks whether to allow MaxRace on the network: allow it on private networks.

## Race recording and report

- **Race** (top bar): recording starts by itself at the start gun, or with "Start recording now". The button turns red and shows the race time.
- Course roundings are logged by themselves; without a course, press "Log mark" at each rounding.
- **Finish race** saves the race and opens the performance report: % of polar over time, track coloured by % of polar, wind, point of sail summary, leg by leg (with tacks and gybes), verdict.
- Each race is written to **Documents › MaxRace › Races** as CSV, GPX, report HTML and report PDF (File → Open races folder).
- "Import track CSV" builds the same report from a CSV made by MaxRace (or any CSV with time, lat, lon and the wind and speed columns).

## Get the installer without installing anything (GitHub)

1. Create a private repository on GitHub and upload this whole folder (including the hidden `.github` folder).
2. Open the **Actions** tab → **Build MaxRace** → **Run workflow**.
3. After about 10 minutes, open the finished run: at the bottom, under **Artifacts**, download
   - `MaxRace-Windows` → `MaxRace-Setup.exe` (one-click installer, creates the desktop icon)
   - `MaxRace-macOS` → `MaxRace-1.0.0-mac-universal.dmg`

## Build on your own computer

Requires Node.js 20 or later.

```
npm install
npm start          # run it without installing
npm run dist       # make the installer in the dist folder
```

## Notes

- The installers are **not code-signed**. Windows SmartScreen shows "Windows protected your PC": choose *More info → Run anyway*. On Mac: right-click the app → *Open* the first time.
- Fonts are downloaded at build time so the program works offline. Without internet during the build it falls back to system fonts.
- `node server.js --source tcp:192.168.1.50:10110` runs the same data server without the window, for example on a Raspberry Pi, and serves the dash to the tablets.
