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

## iPhone and iPad

The `ios` folder is the same dashboard as a native app. The app connects to the NMEA gateway over TCP/UDP itself, can run on the phone's own GPS with the wind typed in by hand, and saves races to the Files app (MaxRace › Races) with the PDF report.

- Every push builds `MaxRace-iOS-unsigned.ipa` in the "latest" release. It installs with a free Apple ID through Sideloadly or AltStore and runs for 7 days before it has to be installed again.
- With an Apple Developer account, add the secrets listed at the top of `.github/workflows/ios.yml`. Every push then also goes to TestFlight.

## iPhone, iPad and Android (Capacitor)

`native/` is the same dashboard as a Capacitor app for iPhone, iPad and Android, with one native plugin
(`MaxRace`) that opens the NMEA 0183 source over TCP/UDP, reads the phone GPS and compass, and saves races.
The page talks to it with the same commands as the earlier iOS app (`ios/`), which stays until this one is tested on the water.

- Android: the socket is bound to the Wi-Fi, so it works on a boat network without internet. Races go to Documents › MaxRace › Races; "PDF / Share" makes the report PDF through the Android print dialog.
- **Recording with the screen off.** While a race is recorded the app itself writes every NMEA sentence (and the GPS fixes when the phone GPS is the source) to `<race> NMEA log.txt`, one line per sentence with the time in ms, flushed every second; a crash or a flat battery loses a few seconds at most, and reopening the app during the race goes on with the same file. At "Finish race" the page reads the log back and fills the minutes it missed while the screen was off or the app in the background, so CSV, GPX and report cover the whole race. The log stays in the race folder next to the CSV (for the true wind of the whole race).
  - Android: a foreground service with the notification "MaxRace sta registrando la regata", a partial wake lock and a Wi-Fi lock. If the phone maker adds its own battery saver (Samsung, Xiaomi, Huawei…), set MaxRace to "Unrestricted" in the app's battery settings. Swiping the app away from the recent apps stops the recording until it is opened again.
  - iOS: while recording the app keeps the location updates on, allowed in the background (blue location indicator), which keeps the app and the TCP connection running with the screen locked. It needs location access ("While Using" is enough; the app asks at the first recording). Without it, or if the app is force-quit from the app switcher or ended by iOS for memory, recording stops until the app is opened again.
  - In a browser or on the desktop the recording still lives in the page: MaxRace keeps the screen on where the browser allows it, and warns (tab title while hidden, red banner on return) when a hidden page missed part of the race.
- Every push to `main` or a `feat/capacitor-*` branch builds `MaxRace-Android-debug.apk` and `MaxRace-iOS-cap-unsigned.ipa` (Actions › Build MaxRace mobile › Artifacts).
- On your own computer (Xcode for iOS, Android Studio for Android): `npm install`, then `npm run cap:sync`, then open `native/ios/App/App.xcodeproj` or the `native/android` folder.

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
