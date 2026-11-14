// The race log written by the app itself, so a race is recorded whole even when the screen is off and the
// page is suspended. One line per NMEA sentence, "<epoch ms>\t<sentence>"; phone GPS fixes as
// "<epoch ms>\t{json}"; notes as "# ...". Appended and flushed every second, synced to the storage every
// 5 s, so a crash or a dead battery loses a few seconds at most. Starting again with the same folder
// (the app was closed in the middle of a race) appends to the same file.
// The file is in Files › On My iPhone/iPad › MaxRace › Races › <race>, next to the CSV and the report.
import Foundation

final class RaceLog {
    private let q = DispatchQueue(label: "maxrace.racelog")
    private var handle: FileHandle?
    private var buf = Data()
    private var lastSync = Date()
    private var timer: DispatchSourceTimer?
    private var cur: String?     // folder of the race being written
    private var file: URL?

    static func url(_ folder: String) -> URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Races", isDirectory: true)
            .appendingPathComponent(folder, isDirectory: true)
            .appendingPathComponent(folder + " NMEA log.txt")
    }

    private static func iso(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: d)
    }

    private static func ms() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    var active: Bool { q.sync { handle != nil } }
    var folder: String? { q.sync { cur } }

    /// Opens (or reopens, appending) the log of this race.
    func start(folder: String, boat: String) throws {
        try q.sync {
            if handle != nil, folder == cur { return }
            closeLocked()
            let u = RaceLog.url(folder)
            try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            let fm = FileManager.default
            let resumed = ((try? fm.attributesOfItem(atPath: u.path)[.size] as? NSNumber)?.intValue ?? 0) > 0
            if !fm.fileExists(atPath: u.path) { fm.createFile(atPath: u.path, contents: nil) }
            let h = try FileHandle(forWritingTo: u)
            try h.seekToEnd()
            handle = h
            file = u
            cur = folder
            buf.append(Data((resumed ? "# resumed \(RaceLog.iso(Date()))\n"
                                     : "# MaxRace race log v1\tfolder=\(folder)\tboat=\(boat)\tstart=\(RaceLog.iso(Date()))\n").utf8))
            writeLocked(sync: true)
            let t = DispatchSource.makeTimerSource(queue: q)
            t.schedule(deadline: .now() + 1, repeating: 1)
            t.setEventHandler { [weak self] in self?.writeLocked(sync: false) }
            t.resume()
            timer = t
        }
    }

    func lines(_ lines: [String]) {
        let t = RaceLog.ms()
        q.async {
            guard self.handle != nil else { return }
            for s in lines { self.buf.append(Data("\(t)\t\(s)\n".utf8)) }
            if self.buf.count > 262_144 { self.writeLocked(sync: false) }
        }
    }

    func gps(_ json: String) {
        let t = RaceLog.ms()
        q.async {
            guard self.handle != nil else { return }
            self.buf.append(Data("\(t)\t\(json)\n".utf8))
        }
    }

    func note(_ text: String) {
        let t = RaceLog.ms()
        q.async {
            guard self.handle != nil else { return }
            self.buf.append(Data("# \(t) \(text.replacingOccurrences(of: "\n", with: " "))\n".utf8))
        }
    }

    func flush() { q.sync { writeLocked(sync: true) } }

    private func writeLocked(sync: Bool) {
        guard let h = handle else { return }
        if !buf.isEmpty {
            do { try h.write(contentsOf: buf) } catch { return }
            buf.removeAll(keepingCapacity: true)
        }
        if sync || Date().timeIntervalSince(lastSync) >= 5 {
            try? h.synchronize()
            lastSync = Date()
        }
    }

    private func closeLocked() {
        timer?.cancel(); timer = nil
        if handle != nil {
            buf.append(Data("# stopped \(RaceLog.iso(Date()))\n".utf8))
            writeLocked(sync: true)
            try? handle?.close()
        }
        handle = nil
        buf = Data()
        file = nil
        cur = nil
    }

    /// Stops writing. With discard the file goes too (and the race folder, when nothing else is in it).
    func stop(discard: Bool) {
        q.sync {
            let f = cur
            closeLocked()
            if discard, let f = f {
                let u = RaceLog.url(f)
                try? FileManager.default.removeItem(at: u)
                let dir = u.deletingLastPathComponent()
                if (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.isEmpty == true {
                    try? FileManager.default.removeItem(at: dir)
                }
            }
        }
    }

    /// Reads the log back for the page, in chunks; AIS sentences and notes are left out (the report does not use them).
    func read(folder: String, chunk: Int, out: @escaping ([String], Bool, String?) -> Void) {
        q.async {
            if self.cur == folder { self.writeLocked(sync: false) }
            let u = RaceLog.url(folder)
            guard let data = try? Data(contentsOf: u, options: .mappedIfSafe) else {
                out([], true, "no native log for this race"); return
            }
            var batch: [String] = []
            batch.reserveCapacity(chunk)
            var start = data.startIndex
            while start < data.endIndex {
                let end = data[start...].firstIndex(of: 10) ?? data.endIndex
                let line = data[start..<end]
                start = end < data.endIndex ? data.index(after: end) : end
                guard let tab = line.firstIndex(of: 9), tab > line.startIndex, line.first != 35 /* # */ else { continue }
                let next = line.index(after: tab)
                if next >= line.endIndex || line[next] == 33 /* ! AIS */ { continue }
                if let s = String(data: line, encoding: .isoLatin1) {
                    batch.append(s.trimmingCharacters(in: .whitespacesAndNewlines))
                    if batch.count >= chunk { out(batch, false, nil); batch = [] }
                }
            }
            out(batch, true, nil)
        }
    }
}
