// NMEA 0183 from the boat's gateway over TCP (client) or UDP (listener), one sentence per line.
// Reconnects by itself every 3 s when the source is not reachable.
import Foundation
import Network

final class NMEASource {
    var onLines: (([String]) -> Void)?
    var onStatus: ((Bool, String?) -> Void)?

    private let q = DispatchQueue(label: "maxrace.nmea")
    private var gen = 0
    private var conn: NWConnection?
    private var listener: NWListener?
    private var udpConns: [NWConnection] = []
    private var buf = Data()
    private var proto = "tcp", host = "", port = 0
    private var active = false

    func connect(proto: String, host: String, port: Int) {
        q.async {
            self.stopLocked()
            self.proto = proto.lowercased()
            self.host = host.trimmingCharacters(in: .whitespaces)
            self.port = port
            self.active = true
            self.open(self.gen)
        }
    }

    func stop() {
        q.async { self.stopLocked(); self.active = false }
    }

    private func stopLocked() {
        gen += 1
        conn?.cancel(); conn = nil
        listener?.cancel(); listener = nil
        udpConns.forEach { $0.cancel() }; udpConns = []
        buf = Data()
    }

    private func status(_ ok: Bool, _ err: String?) {
        let cb = onStatus
        DispatchQueue.main.async { cb?(ok, err) }
    }

    private func retry(_ g: Int, _ err: String) {
        guard g == gen, active else { return }
        status(false, err)
        stopLocked()
        let g2 = gen
        q.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self = self, self.active, g2 == self.gen else { return }
            self.open(g2)
        }
    }

    private func open(_ g: Int) {
        guard port > 0, port < 65536, let p = NWEndpoint.Port(rawValue: UInt16(port)) else {
            status(false, "invalid port"); return
        }
        if proto == "udp" { openUDP(g, p) } else { openTCP(g, p) }
    }

    private func openTCP(_ g: Int, _ p: NWEndpoint.Port) {
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = 8
        tcp.enableKeepalive = true
        let params = NWParameters(tls: nil, tcp: tcp)
        let c = NWConnection(host: NWEndpoint.Host(host), port: p, using: params)
        conn = c
        c.stateUpdateHandler = { [weak self] st in
            guard let self = self, g == self.gen else { return }
            switch st {
            case .ready:
                self.status(true, nil)
                self.receiveTCP(c, g)
            case .waiting(let e):
                self.retry(g, e.localizedDescription)
            case .failed(let e):
                self.retry(g, e.localizedDescription)
            default:
                break
            }
        }
        c.start(queue: q)
    }

    private func receiveTCP(_ c: NWConnection, _ g: Int) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            guard let self = self, g == self.gen else { return }
            if let d = data, !d.isEmpty { self.feed(d) }
            if let e = err { self.retry(g, e.localizedDescription); return }
            if done { self.retry(g, "connection closed by the source"); return }
            self.receiveTCP(c, g)
        }
    }

    private func openUDP(_ g: Int, _ p: NWEndpoint.Port) {
        let params = NWParameters.udp
        params.allowLocalEndpointReuse = true
        do {
            let l = try NWListener(using: params, on: p)
            listener = l
            let only = host
            l.newConnectionHandler = { [weak self] nc in
                guard let self = self, g == self.gen else { nc.cancel(); return }
                if !only.isEmpty, case let .hostPort(h, _) = nc.endpoint, !"\(h)".hasPrefix(only) {
                    nc.cancel(); return
                }
                self.udpConns.append(nc)
                nc.start(queue: self.q)
                self.receiveUDP(nc, g)
            }
            l.stateUpdateHandler = { [weak self] st in
                guard let self = self, g == self.gen else { return }
                switch st {
                case .ready: self.status(true, nil)
                case .failed(let e): self.retry(g, e.localizedDescription)
                default: break
                }
            }
            l.start(queue: q)
        } catch {
            retry(g, error.localizedDescription)
        }
    }

    private func receiveUDP(_ c: NWConnection, _ g: Int) {
        c.receiveMessage { [weak self] data, _, _, err in
            guard let self = self, g == self.gen else { return }
            if let d = data, !d.isEmpty {
                self.feed(d)
                if d.last != 10 { self.feed(Data([10])) }
            }
            if err == nil { self.receiveUDP(c, g) }
        }
    }

    private func feed(_ d: Data) {
        buf.append(d)
        var lines: [String] = []
        while let i = buf.firstIndex(of: 10) {
            let line = buf.subdata(in: buf.startIndex..<i)
            buf.removeSubrange(buf.startIndex...i)
            if let s = String(data: line, encoding: .isoLatin1)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
                lines.append(s)
            }
        }
        if buf.count > 65536 { buf = Data() }
        if !lines.isEmpty {
            let cb = onLines
            DispatchQueue.main.async { cb?(lines) }
        }
    }
}

// "Find": looks for the instrument data on the boat Wi-Fi for someone who does not know the gateway's address.
// Every address of the phone's network (/24) on the ports NMEA gateways use, over TCP, while listening for UDP
// broadcasts; each answer is recognised (NMEA 0183, AIS only, raw NMEA 2000, Signal K, open but silent).
// The same rules as scan.js in the computer program, so every MaxRace finds the same sources.
final class NetScan {
    var onState: (([String: Any]) -> Void)?

    static let tcpPorts: [UInt16] = [10110, 2000, 1456, 60001, 39150, 3000, 2002, 1457, 60002, 2001, 5000, 5001, 4000, 8888, 6000, 2947, 23]
    static let udpPorts: [UInt16] = [10110, 2000, 1456, 1457, 2002, 60002, 5000, 6000]

    private let q = DispatchQueue(label: "maxrace.scan")
    private var gen = 0, running = false, done = 0, total = 0, next = 0, inFlight = 0
    private var jobs: [(String, UInt16)] = []
    private var found: [[String: Any]] = []
    private var netName = "", myIp = "", error: String?
    private var udp: [Int32] = []
    private var lastEmit = 0.0

    func start() { q.async { self.begin() } }
    func stop() { q.async { self.gen += 1; self.running = false; self.closeUdp(); self.emit(true) } }

    private func begin() {
        gen += 1
        let g = gen
        closeUdp(); found = []; done = 0; next = 0; inFlight = 0; error = nil
        guard let ip = NetScan.wifiAddress() else {
            running = false; total = 0; netName = ""
            error = "This phone is not on a Wi-Fi network. Join the boat Wi-Fi first."
            emit(true); return
        }
        let base = ip.split(separator: ".").prefix(3).joined(separator: ".")
        netName = base + ".0/24"; myIp = ip
        jobs = []
        for port in NetScan.tcpPorts { for i in 1...254 { jobs.append((base + ".\(i)", port)) } }
        total = jobs.count; running = true
        openUdp(g)
        emit(true)
        for _ in 0..<64 { pump(g) }
    }

    private func pump(_ g: Int) {
        guard g == gen, running else { return }
        if next >= jobs.count {
            if inFlight == 0 {
                // a last moment for slow UDP broadcasters
                q.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                    guard let self = self, g == self.gen else { return }
                    self.running = false; self.closeUdp(); self.emit(true)
                }
            }
            return
        }
        let (h, p) = jobs[next]; next += 1; inFlight += 1
        probe(h, p, g)
    }

    private func probe(_ host: String, _ port: UInt16, _ g: Int) {
        guard let np = NWEndpoint.Port(rawValue: port) else { inFlight -= 1; done += 1; pump(g); return }
        let c = NWConnection(host: NWEndpoint.Host(host), port: np, using: .tcp)
        var finished = false, opened = false
        var data = Data()
        let end: () -> Void = { [weak self] in
            guard let self = self, !finished else { return }
            finished = true
            c.cancel()
            if g == self.gen, opened {
                let text = String(decoding: data, as: UTF8.self)
                var f: [String: Any] = ["proto": "tcp", "host": host, "port": Int(port)]
                if let k = NetScan.classify(text) {
                    k.forEach { f[$0.key] = $0.value }
                    f["sample"] = text.split(whereSeparator: \.isNewline).first(where: { $0.hasPrefix("$") || $0.hasPrefix("!") }).map(String.init) ?? ""
                } else { f["kind"] = "open"; f["what"] = [String](); f["types"] = [String](); f["score"] = 1 }
                self.add(f)
            }
            self.inFlight -= 1; self.done += 1
            self.emit(false)
            self.pump(g)
        }
        func read() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { d, _, complete, err in
                if let d = d { data.append(d) }
                if data.count > 4096 || complete || err != nil { end() } else { read() }
            }
        }
        c.stateUpdateHandler = { st in
            switch st {
            case .ready:
                opened = true
                if port == 3000 { c.send(content: "GET /signalk HTTP/1.0\r\nHost: \(host)\r\n\r\n".data(using: .utf8), completion: .contentProcessed { _ in }) }
                read()
                self.q.asyncAfter(deadline: .now() + 2.5) { end() }
            case .failed, .cancelled, .waiting: end()       // waiting = refused or unreachable: nothing there
            default: break
            }
        }
        c.start(queue: q)
        q.asyncAfter(deadline: .now() + 0.8) { if !opened { end() } }
    }

    private func add(_ f: [String: Any]) {
        let key = { (x: [String: Any]) in "\(x["proto"] ?? "") \(x["host"] ?? ""):\(x["port"] ?? "")" }
        let s = { (x: [String: Any]) in (x["score"] as? Int) ?? 0 }
        if let i = found.firstIndex(where: { key($0) == key(f) }) { if s(f) > s(found[i]) { found[i] = f } }
        else { found.append(f) }
        found.sort { s($0) > s($1) }
        emit(true)
    }

    private func emit(_ force: Bool) {
        let now = Date().timeIntervalSince1970
        if !force && now - lastEmit < 0.3 { return }
        lastEmit = now
        var o: [String: Any] = ["running": running, "done": done, "total": total, "net": netName, "ip": myIp, "found": found]
        if let e = error { o["error"] = e }
        let cb = onState
        DispatchQueue.main.async { cb?(o) }
    }

    // UDP: gateways that broadcast. Plain sockets, one reader each, on their ports for the whole search.
    private func openUdp(_ g: Int) {
        for port in NetScan.udpPorts {
            let s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            if s < 0 { continue }
            var one: Int32 = 1
            setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(s, SOL_SOCKET, SO_REUSEPORT, &one, socklen_t(MemoryLayout<Int32>.size))
            var tv = timeval(tv_sec: 0, tv_usec: 400_000)
            setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
            var a = sockaddr_in()
            a.sin_family = sa_family_t(AF_INET); a.sin_port = port.bigEndian; a.sin_addr.s_addr = INADDR_ANY
            let ok = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            if ok != 0 { close(s); continue }
            udp.append(s)
            DispatchQueue.global(qos: .utility).async { [weak self] in
                var buf = [UInt8](repeating: 0, count: 4096)
                while true {
                    guard let self = self else { return }
                    var from = sockaddr_in(), len = socklen_t(MemoryLayout<sockaddr_in>.size)
                    let n = withUnsafeMutablePointer(to: &from) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(s, &buf, buf.count, 0, $0, &len) } }
                    var alive = false
                    self.q.sync { alive = g == self.gen && self.running }
                    if !alive { return }
                    if n <= 0 { continue }
                    let text = String(decoding: buf[0..<n], as: UTF8.self)
                    guard let k = NetScan.classify(text + "\n" + text) else { continue }
                    var ipb = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                    var addr = from.sin_addr
                    inet_ntop(AF_INET, &addr, &ipb, socklen_t(INET_ADDRSTRLEN))
                    var f: [String: Any] = ["proto": "udp", "host": String(cString: ipb), "port": Int(port), "sample": text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""]
                    k.forEach { f[$0.key] = $0.value }
                    self.q.async { if g == self.gen { self.add(f) } }
                }
            }
        }
    }
    private func closeUdp() { udp.forEach { close($0) }; udp = [] }

    // what a few kilobytes from a source are, and in words for the list (same as scan.js)
    static func classify(_ text: String) -> [String: Any]? {
        var types = Set<String>(), n = 0
        if let re = try? NSRegularExpression(pattern: "[$!]([A-Z]{2})([A-Z]{3}),") {
            for m in re.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                if let r = Range(m.range(at: 2), in: text) { types.insert(String(text[r])); n += 1 }
            }
        }
        let has = { (k: [String]) in k.contains { types.contains($0) } }
        var what: [String] = []
        if has(["MWV", "MWD", "VWR", "VWT"]) { what.append("wind") }
        if has(["HDT", "HDG", "HDM"]) { what.append("heading") }
        if has(["VHW"]) { what.append("boat speed") }
        if has(["RMC", "GGA", "GLL", "VTG"]) { what.append("GPS") }
        if has(["DPT", "DBT"]) { what.append("depth") }
        if has(["VDM", "VDO"]) { what.append("AIS") }
        if has(["PCDIN"]) { what.append("NMEA 2000 inside 0183") }
        if n >= 2 {
            let inst = has(["MWV", "MWD", "HDT", "HDG", "HDM", "VHW"])
            let kind = inst ? "nmea" : (what == ["AIS"] ? "ais" : "nmea")
            return ["kind": kind, "what": what, "types": types.sorted(), "score": (inst ? 100 : 40) + what.count * 5 + min(n, 20)]
        }
        if text.range(of: "\\d\\d:\\d\\d:\\d\\d\\.\\d{3} [RT] [0-9A-F]{8}", options: .regularExpression) != nil {
            return ["kind": "n2k", "what": ["NMEA 2000 (raw)"], "types": [String](), "score": 10]
        }
        if text.range(of: "signalk-ws|\"signalk\"|signalk-http", options: [.regularExpression, .caseInsensitive]) != nil {
            return ["kind": "signalk", "what": ["Signal K"], "types": [String](), "score": 30]
        }
        return nil
    }

    // the phone's Wi-Fi address (en0)
    static func wifiAddress() -> String? {
        var ifa: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifa) == 0, let first = ifa else { return nil }
        defer { freeifaddrs(ifa) }
        var p: UnsafeMutablePointer<ifaddrs>? = first
        while let i = p {
            let a = i.pointee
            if String(cString: a.ifa_name) == "en0", let sa = a.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) {
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    let s = String(cString: host)
                    if !s.hasPrefix("169.254.") { return s }
                }
            }
            p = a.ifa_next
        }
        return nil
    }
}

// Voice for the tactician: speaks in the earphones (AirPods), listens in Italian on the phone (no internet), and
// the earphone stem (play/pause) starts listening. To get the stem MaxRace must be the "now playing" app, so while
// it is on it plays silence; the audio background mode keeps it alive with the screen off.
import AVFoundation
import Speech
import MediaPlayer

final class VoiceIO: NSObject, AVSpeechSynthesizerDelegate {
    var onHeard: ((String, Bool) -> Void)?
    var onState: (([String: Any]) -> Void)?
    var onStem: (() -> Void)?

    private let synth = AVSpeechSynthesizer()
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "it-IT"))
    private var silence: AVAudioPlayer?
    private var stemOn = false
    private var endTimer: Timer?
    private var lastText = ""

    override init() { super.init(); synth.delegate = self }

    private func session() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .allowBluetoothA2DP, .duckOthers, .defaultToSpeaker])
        try? s.setActive(true)
    }

    func say(_ text: String, flush: Bool) {
        session()
        if flush { synth.stopSpeaking(at: .immediate) }
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "it-IT")
        u.rate = 0.53
        synth.speak(u)
    }
    func hush() { synth.stopSpeaking(at: .immediate) }

    func listen() {
        hush()
        SFSpeechRecognizer.requestAuthorization { st in
            DispatchQueue.main.async {
                guard st == .authorized else { self.fail("Riconoscimento vocale non permesso: abilitalo in Impostazioni, MaxRace."); return }
                AVAudioSession.sharedInstance().requestRecordPermission { ok in
                    DispatchQueue.main.async { ok ? self.start() : self.fail("Microfono non permesso: abilitalo in Impostazioni, MaxRace.") }
                }
            }
        }
    }
    private func fail(_ t: String) { onState?(["listening": false, "error": t]) }

    private func start() {
        guard let rec = recognizer, rec.isAvailable else { fail("Il riconoscimento in italiano non è disponibile su questo telefono."); return }
        stopListening(send: false)
        session()
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }   // at sea there is no internet
        request = req; lastText = ""
        let input = engine.inputNode, fmt = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in req.append(buf) }
        engine.prepare()
        do { try engine.start() } catch { fail("Il microfono non parte."); return }
        AudioServicesPlaySystemSound(1113)
        onState?(["listening": true])
        task = rec.recognitionTask(with: req) { [weak self] res, err in
            guard let self = self else { return }
            if let r = res {
                self.lastText = r.bestTranscription.formattedString
                if r.isFinal { self.finish() } else { self.onHeard?(self.lastText, false); self.armEnd(1.4) }
            } else if err != nil { self.finish() }
        }
        armEnd(6)      // nothing said: give up after 6 s
    }
    // the question is over after a short pause
    private func armEnd(_ s: TimeInterval) {
        endTimer?.invalidate()
        endTimer = Timer.scheduledTimer(withTimeInterval: s, repeats: false) { [weak self] _ in self?.finish() }
    }
    private var finishing = false
    private func finish() {
        if finishing { return }
        finishing = true
        let t = lastText
        stopListening(send: true)
        AudioServicesPlaySystemSound(1114)
        onHeard?(t, true)
        finishing = false
    }
    private func stopListening(send: Bool) {
        endTimer?.invalidate(); endTimer = nil
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio(); request = nil
        task?.cancel(); task = nil
    }

    // earphone stem: MaxRace becomes the now-playing app with a silent loop, and play/pause starts listening
    func setStem(_ on: Bool) {
        stemOn = on
        let cc = MPRemoteCommandCenter.shared()
        [cc.togglePlayPauseCommand, cc.playCommand, cc.pauseCommand].forEach { $0.removeTarget(nil) }
        if !on { silence?.stop(); silence = nil; MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        session()
        if silence == nil, let p = try? AVAudioPlayer(data: VoiceIO.silentWav()) { p.numberOfLoops = -1; p.volume = 0; silence = p }
        silence?.play()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: "MaxRace", MPMediaItemPropertyArtist: "Premi per chiedere"]
        for c in [cc.togglePlayPauseCommand, cc.playCommand, cc.pauseCommand] {
            c.isEnabled = true
            c.addTarget { [weak self] _ in DispatchQueue.main.async { self?.onStem?() }; return .success }
        }
    }
    // one second of silence, 8 kHz mono 16 bit
    static func silentWav() -> Data {
        let rate: UInt32 = 8000, n = rate
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(36 + n * 2); d.append("WAVEfmt ".data(using: .ascii)!)
        u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(n * 2); d.append(Data(count: Int(n * 2)))
        return d
    }
    // after speaking, the silent loop must keep MaxRace as the now-playing app
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { if stemOn && silence?.isPlaying == false { silence?.play() } }
}
