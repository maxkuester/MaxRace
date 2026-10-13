// The dashboard page in a full-screen web view, and the bridge between the page and iOS.
// Page -> app (window.webkit.messageHandlers.mr.postMessage):
//   {cmd:"connect", proto, host, port} / {cmd:"disconnect"}   NMEA source
//   {cmd:"gps", on}                                            phone GPS on/off
//   {cmd:"save", folder, files:{name:text}, pdf:"x.html"}      finished race -> Files app (+ PDF)
//   {cmd:"share", name, text}                                  CSV, GPX… -> share sheet
//   {cmd:"pdfShare", name, html}                               report PDF -> share sheet
// App -> page: MRN.lines([..]), MRN.status({connected,error}), MRN.gps({..}), MRN.gpsError(t), MRN.saved({..})
import UIKit
import WebKit
import CoreLocation

final class DashViewController: UIViewController, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, CLLocationManagerDelegate {
    private var web: WKWebView!
    private let nmea = NMEASource()
    private let loc = CLLocationManager()
    private var gpsOn = false
    private var heading: Double = -1
    private var pending: [String] = []
    private var flushTimer: Timer?
    private var pdfMakers: [PDFMaker] = []

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        let ucc = WKUserContentController()
        ucc.add(WeakHandler(self), name: "mr")
        let cfg = WKWebViewConfiguration()
        cfg.userContentController = ucc
        cfg.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        web.uiDelegate = self
        web.navigationDelegate = self
        if #available(iOS 16.4, *) { web.isInspectable = true }
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: g.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: g.trailingAnchor),
            web.topAnchor.constraint(equalTo: g.topAnchor),
            web.bottomAnchor.constraint(equalTo: g.bottomAnchor),
        ])

        nmea.onLines = { [weak self] lines in self?.pending.append(contentsOf: lines) }
        nmea.onStatus = { [weak self] ok, err in
            var o: [String: Any] = ["connected": ok]
            if let e = err { o["error"] = e }
            self?.send("MRN.status", o)
        }
        // sentences go to the page in small batches, ten times a second
        flushTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.flush() }

        loc.delegate = self
        loc.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        loc.distanceFilter = kCLDistanceFilterNone
        loc.activityType = .otherNavigation
        loc.pausesLocationUpdatesAutomatically = false
        loc.headingFilter = 1

        if let url = Bundle.main.url(forResource: "maxrace", withExtension: "html", subdirectory: "web") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
    }

    // MARK: page <-> app

    private func flush() {
        guard !pending.isEmpty else { return }
        let batch = pending
        pending.removeAll()
        send("MRN.lines", batch)
    }

    private func send(_ fn: String, _ obj: Any) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: [.fragmentsAllowed]),
              let json = String(data: d, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.MRN&&\(fn)(\(json))", completionHandler: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let b = message.body as? [String: Any], let cmd = b["cmd"] as? String else { return }
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
            send("MRN.gpsError", "Location access is off for MaxRace. Turn it on in Settings › Privacy & Security › Location Services › MaxRace.")
            return
        default:
            break
        }
        loc.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { loc.startUpdatingHeading() }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard gpsOn else { return }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            send("MRN.gpsError", "Location access is off for MaxRace. Turn it on in Settings › Privacy & Security › Location Services › MaxRace.")
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
            if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard gpsOn, let l = locations.last, l.horizontalAccuracy >= 0 else { return }
        var o: [String: Any] = [
            "lat": l.coordinate.latitude, "lon": l.coordinate.longitude,
            "acc": l.horizontalAccuracy, "t": l.timestamp.timeIntervalSince1970 * 1000,
        ]
        if l.speed >= 0 { o["sog"] = l.speed * 1.943844 }     // m/s -> knots
        if l.course >= 0 { o["cog"] = l.course }
        if heading >= 0 { o["hdg"] = heading }
        send("MRN.gps", o)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if let e = error as? CLError, e.code == .locationUnknown { return }   // temporary, keeps trying
        send("MRN.gpsError", "GPS: " + error.localizedDescription)
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
            send("MRN.saved", ["ok": false, "error": error.localizedDescription])
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
            self?.send("MRN.saved", ["ok": true, "dir": shown, "pdf": ok])
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
        var maker: PDFMaker?
        maker = PDFMaker(host: view, html: html) { [weak self] data in
            if let m = maker { self?.pdfMakers.removeAll { $0 === m } }
            maker = nil
            done(data)
        }
        if let m = maker { pdfMakers.append(m) }
    }

    private func shareFile(name: String, data: Data) {
        var n = clean(name)
        if n.isEmpty { n = "MaxRace.txt" }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(n)
        do { try data.write(to: url, options: .atomic) } catch { alert("Could not prepare the file: \(error.localizedDescription)"); return }
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: 60, width: 1, height: 1)
        }
        topController().present(vc, animated: true)
    }

    // MARK: alert / confirm / prompt from the page (a web view shows none of them by itself)

    private func topController() -> UIViewController {
        var c: UIViewController = self
        while let p = c.presentedViewController { c = p }
        return c
    }

    private func alert(_ text: String) {
        let a = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        topController().present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        topController().present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        topController().present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(a.textFields?.first?.text) })
        topController().present(a, animated: true)
    }

    // links to the web open in Safari, not inside the dashboard
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = navigationAction.request.url, let s = u.scheme?.lowercased(),
           s == "http" || s == "https", navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = navigationAction.request.url { UIApplication.shared.open(u) }
        return nil
    }

    // the web content process can be stopped by iOS in the background: reload instead of a blank screen
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// Avoids the retain cycle between the web view's content controller and the view controller.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
