// The bridge between the dashboard page and iOS, as a Capacitor plugin.
// Same commands as the earlier MaxRace iOS app, so the page is unchanged apart from how it sends them:
// Page -> app: Capacitor.nativePromise("MaxRace", "post", {cmd, ...})
//   {cmd:"connect", proto, host, port} / {cmd:"disconnect"}   NMEA source
//   {cmd:"gps", on}                                            phone GPS on/off
//   {cmd:"save", folder, files:{name:text}, pdf:"x.html"}      finished race -> Files app (+ PDF)
//   {cmd:"share", name, text}                                  CSV, GPX… -> share sheet
//   {cmd:"pdfShare", name, html}                               report PDF -> share sheet
// App -> page: event "mrn" {fn, arg}; the page calls MRN[fn](arg): lines, status, gps, gpsError, saved
import UIKit
import Capacitor
import CoreLocation

@objc(MaxRacePlugin)
public class MaxRacePlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "MaxRacePlugin"
    public let jsName = "MaxRace"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
    ]

    private let nmea = NMEASource()
    private var loc: CLLocationManager?
    private var gpsOn = false
    private var heading: Double = -1
    private var pending: [String] = []
    private var flushTimer: Timer?
    private var pdfMakers: [PDFMaker] = []

    override public func load() {
        nmea.onLines = { [weak self] lines in self?.pending.append(contentsOf: lines) }
        nmea.onStatus = { [weak self] ok, err in
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
        case "save":
            saveRace(b)
        case "share":
            let text = b["text"] as? String ?? ""
            shareFile(name: b["name"] as? String ?? "MaxRace.txt", data: Data(text.utf8))
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

    // MARK: phone GPS

    private func setGps(_ on: Bool) {
        guard let loc = loc else { return }
        gpsOn = on
        if !on {
            loc.stopUpdatingLocation()
            loc.stopUpdatingHeading()
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
        guard gpsOn, let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        var o: [String: Any] = [
            "lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
            "acc": l.horizontalAccuracy, "t": l.timestamp.timeIntervalSince1970 * 1000,
        ]
        if l.speed >= 0 { o["sog"] = l.speed * 1.943844 }     // m/s -> knots
        if l.course >= 0 { o["cog"] = l.course }
        if heading >= 0 { o["hdg"] = heading }
        send("gps", o)
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
