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
