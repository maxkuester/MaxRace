// The bridge between the dashboard page and iOS, as a Capacitor plugin.
// Same commands as the earlier MaxRace iOS app, so the page is unchanged apart from how it sends them:
// Page -> app: Capacitor.nativePromise("MaxRace", "post", {cmd, ...})
//   {cmd:"connect", proto, host, port} / {cmd:"disconnect"}   NMEA source
//   {cmd:"gps", on}                                            phone GPS on/off
//   {cmd:"save", folder, files:{name:text}, pdf:"x.html"}      finished race -> Files app (+ PDF)
//   {cmd:"share", name, text}                                  CSV, GPX… -> share sheet
//   {cmd:"pdfShare", name, html}                               report PDF -> share sheet
//   {cmd:"recStart", folder, boat} / {cmd:"recStop", discard}  race log written by the app (RaceLog)
//   {cmd:"recRead", folder}                                    the log back to the page, in chunks
// App -> page: event "mrn" {fn, arg}; the page calls MRN[fn](arg): lines, status, gps, gpsError, saved, rec, recLog
//
// Recording with the screen off: iOS suspends an app in the background unless it has a reason to run.
// While a race is recorded MaxRace keeps the location updates on with background location allowed
// (UIBackgroundModes "location", blue location indicator), which keeps the app and its NMEA socket
// running; sentences and GPS fixes go to RaceLog. The page is not fed while the app is in the background
// (iOS suspends the WebView anyway); at the finish it reads the log back to fill what it missed.
// Limits: it needs location access ("While Using" is enough); if the user turns it off, force-quits the
// app from the app switcher, or iOS ends it for lack of memory, recording stops until the app is opened again.
import UIKit
import Capacitor
import CoreLocation
import CoreMotion

@objc(MaxRacePlugin)
public class MaxRacePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "MaxRacePlugin"
    public let jsName = "MaxRace"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
    ]

    private let nmea = NMEASource()
    private let scanner = NetScan()
    private var loc: CLLocationManager?
    private var gpsOn = false
    private var heading: Double = -1
    private var pending: [String] = []
    private var flushTimer: Timer?
    private var pdfMakers: [PDFMaker] = []
    private let raceLog = RaceLog()
    private var recording = false
    private var inFront = true
    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    private let motion = CMMotionManager()

    override public func load() {
        nmea.onLines = { [weak self] lines in
            guard let self = self else { return }
            self.raceLog.lines(lines)
            if self.inFront { self.pending.append(contentsOf: lines) }
        }
        scanner.onState = { [weak self] st in self?.send("scan", st) }
        nmea.onStatus = { [weak self] ok, err in
            self?.raceLog.note(ok ? "source connected" : "source not connected: \(err ?? "")")
            var o: [String: Any] = ["connected": ok]
            if let e = err { o["error"] = e }
            self?.send("status", o)
        }
        DispatchQueue.main.async {
            // sentences go to the page in small batches, ten times a second
            self.flushTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.flush() }
            UIApplication.shared.isIdleTimerDisabled = true      // the screen stays on while racing
            let l = CLLocationManager()
            l.delegate = self
            l.desiredAccuracy = kCLLocationAccuracyBestForNavigation
            l.distanceFilter = kCLDistanceFilterNone
            l.activityType = .otherNavigation
            l.pausesLocationUpdatesAutomatically = false
            l.headingFilter = 1
            self.loc = l
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            UIApplication.shared.isIdleTimerDisabled = true
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.inFront = false
            self.pending.removeAll()
            if self.recording {
                self.raceLog.note("app in background")
                self.raceLog.flush()
                self.holdBackground()
            }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.inFront = true
            if self.recording { self.raceLog.note("app in front") }
            self.endBackgroundTask()
        }
    }

    // MARK: page <-> app

    private func flush() {
        guard !pending.isEmpty else { return }
        let batch = pending
        pending.removeAll()
        send("lines", batch)
    }

    private func send(_ fn: String, _ arg: Any) {
        notifyListeners("mrn", data: ["fn": fn, "arg": arg])
    }

    @objc func post(_ call: CAPPluginCall) {
        let b = call.options as? [String: Any] ?? [:]
        call.resolve()
        guard let cmd = b["cmd"] as? String else { return }
        DispatchQueue.main.async { self.handle(cmd, b) }
    }

    private func handle(_ cmd: String, _ b: [String: Any]) {
        switch cmd {
        case "connect":
            nmea.connect(proto: b["proto"] as? String ?? "tcp",
                         host: b["host"] as? String ?? "",
                         port: (b["port"] as? NSNumber)?.intValue ?? 0)
        case "disconnect":
            nmea.stop()
            pending.removeAll()
        case "gps":
            setGps((b["on"] as? NSNumber)?.boolValue ?? false)
        case "scan":
            scanner.start()
        case "scanStop":
            scanner.stop()
        case "camDir":
            camDir((b["on"] as? NSNumber)?.boolValue ?? false)
        case "save":
            saveRace(b)
        case "share":
            let text = b["text"] as? String ?? ""
            shareFile(name: b["name"] as? String ?? "MaxRace.txt", data: Data(text.utf8))
        case "recStart":
            recStart(folder: clean(b["folder"] as? String ?? ""), boat: b["boat"] as? String ?? "")
        case "recStop":
            recStop(discard: (b["discard"] as? NSNumber)?.boolValue ?? false)
        case "recRead":
            let folder = clean(b["folder"] as? String ?? "")
            raceLog.read(folder: folder, chunk: 4000) { [weak self] lines, done, err in
                var o: [String: Any] = ["lines": lines, "done": done]
                if let e = err { o["error"] = e }
                DispatchQueue.main.async { self?.send("recLog", o) }
            }
        case "pdfShare":
            let name = b["name"] as? String ?? "MaxRace report.pdf"
            makePdf(html: b["html"] as? String ?? "") { [weak self] data in
                guard let self = self else { return }
                if let d = data { self.shareFile(name: name, data: d) }
                else { self.alert("Could not make the PDF.") }
            }
        default:
            break
        }
    }

    // MARK: race log written by the app, also with the screen off

    private func recStart(folder f: String, boat: String) {
        let folder = f.isEmpty ? "race" : f
        do {
            try raceLog.start(folder: folder, boat: boat)
        } catch {
            send("rec", ["on": false, "error": error.localizedDescription])
            return
        }
        recording = true
        var o: [String: Any] = ["on": true, "folder": folder]
        if let w = keepRunning() { o["warn"] = w }
        send("rec", o)
    }

    private func recStop(discard: Bool) {
        recording = false
        raceLog.stop(discard: discard)
        if let loc = loc {
            loc.allowsBackgroundLocationUpdates = false
            if !gpsOn { loc.stopUpdatingLocation() }
        }
        endBackgroundTask()
    }

    /// Location updates allowed in the background keep the app (and the NMEA socket) running with the screen off.
    /// Returns a warning for the page when iOS will not allow it.
    @discardableResult
    private func keepRunning() -> String? {
        guard recording, let loc = loc else { return nil }
        switch loc.authorizationStatus {
        case .notDetermined:
            loc.requestWhenInUseAuthorization()       // continues in locationManagerDidChangeAuthorization
            return nil
        case .denied, .restricted:
            raceLog.note("location access off: no background recording")
            return "Location access is off for MaxRace, so iOS stops the recording when the screen goes off or you leave the app. Turn it on in Settings › Privacy & Security › Location Services › MaxRace (While Using is enough), or keep MaxRace in front with the screen on."
        default:
            break
        }
        loc.allowsBackgroundLocationUpdates = true
        loc.showsBackgroundLocationIndicator = true
        loc.pausesLocationUpdatesAutomatically = false
        loc.startUpdatingLocation()
        return nil
    }

    // a few more seconds to write the log when the app goes to the background without location access
    private func holdBackground() {
        guard bgTask == .invalid else { return }
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "MaxRace race log") { [weak self] in
            self?.raceLog.note("iOS suspends the app")
            self?.raceLog.flush()
            self?.endBackgroundTask()
        }
    }

    private func endBackgroundTask() {
        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
    }

    // MARK: phone GPS

    // Targets camera: where the back camera points (true north when the phone knows where it is), 15 times a second.
    // CoreMotion gives the phone attitude; the camera looks along the phone's -z axis, projected on the horizon.
    private func camDir(_ on: Bool) {
        if !on { motion.stopDeviceMotionUpdates(); return }
        guard motion.isDeviceMotionAvailable else { send("camDir", ["error": "no motion sensors"]); return }
        let frames = CMMotionManager.availableAttitudeReferenceFrames()
        let ref: CMAttitudeReferenceFrame = frames.contains(.xTrueNorthZVertical) ? .xTrueNorthZVertical : .xMagneticNorthZVertical
        motion.deviceMotionUpdateInterval = 1.0 / 15
        motion.startDeviceMotionUpdates(using: ref, to: .main) { [weak self] dm, _ in
            guard let self = self, let dm = dm else { return }
            let m = dm.attitude.rotationMatrix, g = dm.gravity
            // which way the matrix turns: gravity in the phone frame is minus its third column, or minus its third row
            let byCol = abs(g.x + m.m13) + abs(g.y + m.m23) + abs(g.z + m.m33)
            let byRow = abs(g.x + m.m31) + abs(g.y + m.m32) + abs(g.z + m.m33)
            // the camera axis in the reference frame: x north, y west, z up
            let f = byCol <= byRow ? (-m.m31, -m.m32, -m.m33) : (-m.m13, -m.m23, -m.m33)
            var az = atan2(-f.1, f.0) * 180 / .pi
            if az < 0 { az += 360 }
            let pitch = asin(max(-1, min(1, f.2))) * 180 / .pi
            self.send("camDir", ["az": az, "pitch": pitch, "ref": ref == .xTrueNorthZVertical ? "true" : "mag"])
        }
    }

    private func setGps(_ on: Bool) {
        guard let loc = loc else { return }
        gpsOn = on
        if !on {
            loc.stopUpdatingHeading()
            if !recording { loc.stopUpdatingLocation() }     // still needed to keep a recording alive
            return
        }
        switch loc.authorizationStatus {
        case .notDetermined:
            loc.requestWhenInUseAuthorization()
        case .denied, .restricted:
            send("gpsError", "Location access is off for MaxRace. Turn it on in Settings › Privacy & Security › Location Services › MaxRace.")
            return
        default:
            break
        }
        loc.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { loc.startUpdatingHeading() }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if recording {
            if let w = keepRunning() { send("rec", ["on": true, "folder": raceLog.folder ?? "", "warn": w]) }
            else if manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways {
                send("rec", ["on": true, "folder": raceLog.folder ?? ""])
            }
        }
        guard gpsOn else { return }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            send("gpsError", "Location access is off for MaxRace. Turn it on in Settings › Privacy & Security › Location Services › MaxRace.")
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        default:
            break
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard gpsOn, let l = locations.last, l.horizontalAccuracy >= 0 else { return }   // NMEA source: updates only keep the app running
        var o: [String: Any] = [
            "lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
            "acc": l.horizontalAccuracy, "t": l.timestamp.timeIntervalSince1970 * 1000,
        ]
        if l.speed >= 0 { o["sog"] = l.speed * 1.943844 }     // m/s -> knots
        if l.course >= 0 { o["cog"] = l.course }
        if heading >= 0 { o["hdg"] = heading }
        if recording, let j = try? JSONSerialization.data(withJSONObject: o), let s = String(data: j, encoding: .utf8) { raceLog.gps(s) }
        if inFront { send("gps", o) }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if let e = error as? CLError, e.code == .locationUnknown { return }   // temporary, keeps trying
        send("gpsError", "GPS: " + error.localizedDescription)
    }

    // MARK: races in the Files app

    private func racesDir() -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Races", isDirectory: true)
    }

    private func clean(_ s: String) -> String {
        let bad = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        var t = s.components(separatedBy: bad).joined().trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasPrefix(".") { t.removeFirst() }
        return String(t.prefix(120))
    }

    private func saveRace(_ b: [String: Any]) {
        var folder = clean(b["folder"] as? String ?? "")
        if folder.isEmpty { folder = "race" }
        let dir = racesDir().appendingPathComponent(folder, isDirectory: true)
        let files = b["files"] as? [String: Any] ?? [:]
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for (name, text) in files {
                let n = clean(name)
                if n.isEmpty { continue }
                try (text as? String ?? "").write(to: dir.appendingPathComponent(n), atomically: true, encoding: .utf8)
            }
        } catch {
            send("saved", ["ok": false, "error": error.localizedDescription])
            return
        }
        let shown = "Files › On My " + (UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone") + " › MaxRace › Races › " + folder
        // one report or several (1 SD-trimmed and all points), made one after the other
        let wanted: [String] = (b["pdf"] as? [String]) ?? ((b["pdf"] as? String).map { [$0] } ?? [])
        let jobs = wanted.compactMap { src -> (String, String)? in
            guard let html = files[src] as? String else { return nil }
            return (src, html)
        }
        makePdfs(jobs, into: dir, made: false) { [weak self] ok in
            self?.send("saved", ["ok": true, "dir": shown, "pdf": ok])
        }
    }

    private func makePdfs(_ jobs: [(String, String)], into dir: URL, made: Bool, done: @escaping (Bool) -> Void) {
        guard let (src, html) = jobs.first else { done(made); return }
        makePdf(html: html) { [weak self] data in
            guard let self = self else { return }
            var ok = made
            if let d = data {
                let pdfName = self.clean((src as NSString).deletingPathExtension + ".pdf")
                if (try? d.write(to: dir.appendingPathComponent(pdfName))) != nil { ok = true }
            }
            self.makePdfs(Array(jobs.dropFirst()), into: dir, made: ok, done: done)
        }
    }

    private func makePdf(html: String, done: @escaping (Data?) -> Void) {
        guard let host = bridge?.viewController?.view else { done(nil); return }
        var maker: PDFMaker?
        maker = PDFMaker(host: host, html: html) { [weak self] data in
            if let m = maker { self?.pdfMakers.removeAll { $0 === m } }
            maker = nil
            done(data)
        }
        if let m = maker { pdfMakers.append(m) }
    }

    private func shareFile(name: String, data: Data) {
        guard let host = bridge?.viewController else { return }
        var n = clean(name)
        if n.isEmpty { n = "MaxRace.txt" }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(n)
        do { try data.write(to: url, options: .atomic) } catch { alert("Could not prepare the file: \(error.localizedDescription)"); return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            pop.sourceView = host.view
            pop.sourceRect = CGRect(x: host.view.bounds.midX, y: 60, width: 1, height: 1)
        }
        top(host).present(vc, animated: true)
    }

    private func top(_ c0: UIViewController) -> UIViewController {
        var c = c0
        while let p = c.presentedViewController { c = p }
        return c
    }

    private func alert(_ text: String) {
        guard let host = bridge?.viewController else { return }
        let a = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        top(host).present(a, animated: true)
    }
}
