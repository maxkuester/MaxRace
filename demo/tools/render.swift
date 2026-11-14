// Renders the MaxRace target demo: the phone video with each tracked boat boxed and its telemetry.
import AVFoundation
import AppKit

struct Pt: Decodable { let t: Double; let box: [Double]; let dist: Double; let brg: Double; let lead: Double }
struct Tr: Decodable { let id: Int; var pts: [Pt] }
struct Nav: Decodable { let hdg: Double; let twd: Double; let twa: Double }
struct Data0: Decodable { let nav: Nav; var tracks: [Tr] }

let a = CommandLine.arguments
// settings as key=value after the three file arguments:
//   hdg=309 twd=270 twa=39 bsp=7.4 leg=up|down tack=port|stbd compass=compass.json
// compass.json is the phone compass track, as the live app reads it: [{"t":s,"mag":deg}] magnetic readings
// of the camera direction; align = the offset set with "Align" on the H5000 heading (declination and phone error)
var kv: [String: String] = [:]
for s in a.dropFirst(4) { let p = s.split(separator: "=", maxSplits: 1); if p.count == 2 { kv[String(p[0])] = String(p[1]) } }
struct CompassPt: Decodable { let t: Double; let mag: Double }
struct Compass: Decodable { let align: Double; let pts: [CompassPt] }
let compass = try! JSONDecoder().decode(Compass.self, from: Data(contentsOf: URL(fileURLWithPath: kv["compass"]!)))
// true camera bearing at time t: compass reading interpolated (shortest way round) + alignment
func camAz(_ t: Double) -> Double? {
  let p = compass.pts
  guard let k = p.firstIndex(where: { $0.t >= t }) else { return nil }
  if k == 0 { return p[0].t - t < 0.05 ? (p[0].mag + compass.align + 360).truncatingRemainder(dividingBy: 360) : nil }
  let a0 = p[k - 1], a1 = p[k], u = (t - a0.t) / max(1e-6, a1.t - a0.t)
  var d = (a1.mag - a0.mag).truncatingRemainder(dividingBy: 360); if d > 180 { d -= 360 }; if d < -180 { d += 360 }
  return (a0.mag + d * u + compass.align + 720).truncatingRemainder(dividingBy: 360)
}
let DOWN = kv["leg"] == "down", PORT = kv["tack"] != "stbd"
let HDG = Double(kv["hdg"] ?? "309")!, TWD = Double(kv["twd"] ?? "270")!, TWA = Double(kv["twa"] ?? "39")!, BSP = Double(kv["bsp"] ?? "7.4")!, FOCAL = 540.0 / tan(42.6 / 2 * .pi / 180)
var data = try! JSONDecoder().decode(Data0.self, from: Data(contentsOf: URL(fileURLWithPath: a[2])))
// drop points whose size does not match the rest of the track (a detection of another boat)
func median(_ v: [Double]) -> Double { let s = v.sorted(); return s[s.count / 2] }
// a track whose boat suddenly changes size has jumped to another boat: split it there
var split: [Tr] = []
for tr in data.tracks {
  var cur: [Pt] = []
  for p in tr.pts {
    if let l = cur.last, max(l.box[3], p.box[3]) / min(l.box[3], p.box[3]) > 1.6 { split.append(Tr(id: 0, pts: cur)); cur = [] }
    cur.append(p)
  }
  if !cur.isEmpty { split.append(Tr(id: 0, pts: cur)) }
}
data.tracks = []
for var tr in split {
  let mh = median(tr.pts.map { $0.box[3] })
  tr.pts = tr.pts.filter { abs($0.box[3] - mh) / mh < 0.4 }
  if tr.pts.count >= 2 { data.tracks.append(tr) }
}
data.tracks.sort { $0.pts[0].t < $1.pts[0].t }
// exclude=1,4: targets that are our own boat (our sails seen from deck), by their number before renumbering
let excl = Set((kv["exclude"] ?? "").split(separator: ",").compactMap { Int($0) })
data.tracks = data.tracks.enumerated().filter { !excl.contains($0.offset + 1) }.map { $0.element }
for i in data.tracks.indices { data.tracks[i] = Tr(id: i + 1, pts: data.tracks[i].pts) }

let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let dur = CMTimeGetSeconds(asset.duration)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
let W = 1080, H = 1920, fps = 30.0
let writer = try! AVAssetWriter(outputURL: URL(fileURLWithPath: a[3]), fileType: .mp4)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]])
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
writer.add(input); writer.startWriting(); writer.startSession(atSourceTime: .zero)

let green = NSColor(calibratedRed: 0.25, green: 0.73, blue: 0.31, alpha: 1), red = NSColor(calibratedRed: 0.97, green: 0.32, blue: 0.29, alpha: 1)
func text(_ s: String, _ size: CGFloat, _ w: NSFont.Weight, _ c: NSColor) -> NSAttributedString {
  NSAttributedString(string: s, attributes: [.font: NSFont.systemFont(ofSize: size, weight: w), .foregroundColor: c])
}
// box and values at time t: boxes glide between analysed frames, numbers are the median of the last second
func at(_ tr: Tr, _ t: Double) -> (box: [Double], dist: Double, brg: Double, lead: Double)? {
  let p = tr.pts
  guard t >= p[0].t - 0.17, t <= p[p.count - 1].t + 0.17 else { return nil }
  var k = p.firstIndex { $0.t > t } ?? p.count - 1
  if k == 0 { k = 1 }
  let x = p[k - 1], y = p[k]
  if y.t - x.t > 0.85 && t > x.t + 0.17 && t < y.t - 0.17 { return nil }
  let u = y.t > x.t ? min(1, max(0, (t - x.t) / (y.t - x.t))) : 0
  let box = (0..<4).map { x.box[$0] + (y.box[$0] - x.box[$0]) * u }
  let near = p.filter { abs($0.t - t) <= 1 }
  // bearing = where the phone points + angle of the boat in the picture; lead on the wind axis from it
  guard let cam = camAz(t) else { return nil }
  let d = median(near.map { $0.dist })
  let br = (cam + atan((box[0] + box[2] / 2 - 540) / FOCAL) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
  // ladder lines square to TWD: upwind the boat further upwind is ahead, downwind the one further downwind
  let upwindOfUs = d * cos((br - TWD) * .pi / 180)       // + = the target is upwind of us
  return (box, d, br, DOWN ? upwindOfUs : -upwindOfUs)
}

// the horizon in a frame (pixels from the top): the row where bright sky turns into darker sea
func horizonY(_ cg: CGImage) -> Double? {
  let w = 108, h = 192
  let bytes = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4); defer { bytes.deallocate() }
  let c = CGContext(data: bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  var rows = [Double](repeating: 0, count: h)
  for y in 0..<h { var sum = 0; for x in 0..<w { let k = (y * w + x) * 4; sum += Int(bytes[k]) + Int(bytes[k + 1]) + Int(bytes[k + 2]) }; rows[y] = Double(sum) / Double(w * 3) }
  var best = -1.0, by = -1
  for y in Int(Double(h) * 0.12)..<Int(Double(h) * 0.88) { var a = 0.0, b = 0.0; for k in 1...6 { a += rows[y - k]; b += rows[min(h - 1, y + k)] }; if (a - b) / 6 > best { best = (a - b) / 6; by = y } }
  return best > 15 ? Double(by) / Double(h) * Double(H) : nil
}
// ladder lines on the water: the line through us square to TWD (lead 0) and the parallel ones at lead L.
// A point on the sea at distance d and bearing b shows at x = f tan(rel), y = horizon + f tan(dip) / cos(rel),
// dip = angle below the horizon = atan(camera height / d)
let LADDER = kv["ladder"] == "1" || kv["ladder"] == "parity", CAMH = Double(kv["camh"] ?? "2.0")!, Hf0 = Double(H)
// ladder=1 all lines, ladder=parity only the line through us
let leads: [Double] = kv["ladder"] == "parity" ? [0] : [-100, -50, -25, 0, 25, 50, 100]
// damping (about a quarter of a second at 30 fps) so the line glides instead of jumping with every frame
var hzS: Double? = nil, camS: Double? = nil
func damp(_ cam: Double, _ hz: Double) -> (Double, Double) {
  let a = 0.13
  hzS = hzS.map { $0 + (hz - $0) * a } ?? hz
  if let c = camS { var d = (cam - c).truncatingRemainder(dividingBy: 360); if d > 180 { d -= 360 }; if d < -180 { d += 360 }; camS = (c + d * a + 360).truncatingRemainder(dividingBy: 360) } else { camS = cam }
  return (camS!, hzS!)
}
// top view in a corner: north up, wind arrow from TWD, our boat on HDG, the parity line through the bow
// square to TWD, the camera direction, and the targets as dots (green we are ahead, red behind)
// radar memory: every target seen keeps its last position relative to us (it sails like us: same tack, similar
// speed) after it leaves the picture; drawn hollow and fading out over 60 s
var memory: [Int: (e: Double, n: Double, ahead: Bool, t: Double)] = [:]
func topView(cam: Double, targets: [(Int, Double, Double, Bool)], now: Double) {
  for (id, e, n, a) in targets { memory[id] = (e, n, a, now) }
  // a rectangular section across the bottom of the picture, wind always up, parity horizontal through the middle
  let secY = 92.0, secH = 700.0, Wd = Double(W)
  NSColor.black.withAlphaComponent(0.78).setFill(); NSRect(x: 0, y: secY, width: Wd, height: secH).fill()
  let plot = NSRect(x: 16, y: secY + 16, width: Wd - 32, height: secH - 80)
  NSColor(white: 1, alpha: 0.22).setStroke(); let frame = NSBezierPath(rect: plot); frame.lineWidth = 2; frame.stroke()
  let cx = Double(plot.midX), cy = Double(plot.midY), halfH = Double(plot.height) / 2, halfW = Double(plot.width) / 2
  let range = 150.0, k = halfH / range                           // 150 m to the top and bottom edges
  let T = TWD * .pi / 180
  func up(_ e: Double, _ n: Double) -> (Double, Double) { (e * cos(T) - n * sin(T), e * sin(T) + n * cos(T)) }
  func pt(_ e: Double, _ n: Double) -> NSPoint { let r = up(e, n); return NSPoint(x: cx + r.0 * k, y: cy + r.1 * k) }
  func dir(_ deg: Double, _ len: Double) -> (Double, Double) { (sin(deg * .pi / 180) * len, cos(deg * .pi / 180) * len) }
  NSGraphicsContext.saveGraphicsState(); NSBezierPath(rect: plot).addClip()
  // distance ticks along parity every 50 m, to read the across-wind spread
  let hb = dir(HDG, BOW), ph = up(hb.0, hb.1)
  var m = -500.0
  while m <= 500 {
    if m != 0 { let x = cx + (ph.0 + m) * k, y = cy + ph.1 * k
      if x > Double(plot.minX) + 10 && x < Double(plot.maxX) - 10 {
        let tk = NSBezierPath(); tk.move(to: NSPoint(x: x, y: y - 8)); tk.line(to: NSPoint(x: x, y: y + 8)); tk.lineWidth = 1.5
        NSColor(white: 1, alpha: 0.35).setStroke(); tk.stroke()
        if Int(abs(m)) % 100 == 0 { text(String(format: "%.0f m", abs(m)), 16, .regular, NSColor(white: 1, alpha: 0.45)).draw(at: NSPoint(x: x - 18, y: y - 30)) }
      } }
    m += 50
  }
  // ladder lines: parallel to parity, every 25/50/100 m; above (upwind) ahead of us upwind, below behind
  for L in [25.0, 50.0, 100.0] {
    for side in [1.0, -1.0] {
      let y = cy + (ph.1 + side * L) * k
      let aheadOfUs = (side > 0) == DOWN
      let col = aheadOfUs ? green : red
      let ln = NSBezierPath(); ln.move(to: NSPoint(x: Double(plot.minX), y: y)); ln.line(to: NSPoint(x: Double(plot.maxX), y: y))
      ln.lineWidth = 1.5; ln.setLineDash([8, 7], count: 2, phase: 0); col.withAlphaComponent(0.55).setStroke(); ln.stroke()
      text((aheadOfUs ? "+" : "−") + String(format: "%.0f m", L), 20, .semibold, col.withAlphaComponent(0.95)).draw(at: NSPoint(x: Double(plot.minX) + 10, y: y + 3))
    }
  }
  // parity line through the phone/bow, square to TWD: horizontal across the whole section
  let pl = NSBezierPath(); pl.move(to: NSPoint(x: Double(plot.minX), y: cy + ph.1 * k)); pl.line(to: NSPoint(x: Double(plot.maxX), y: cy + ph.1 * k))
  pl.lineWidth = 3; pl.setLineDash([14, 8], count: 2, phase: 0); NSColor.white.setStroke(); pl.stroke()
  text("parità", 20, .bold, .white).draw(at: NSPoint(x: Double(plot.minX) + 10, y: cy + ph.1 * k + 4))
  // camera direction (what the phone sees)
  let cv = dir(cam, range * 1.6), cl = NSBezierPath(); cl.move(to: pt(0, 0)); cl.line(to: pt(cv.0, cv.1)); cl.lineWidth = 2
  NSColor(calibratedRed: 0.3, green: 0.64, blue: 1, alpha: 0.9).setStroke(); cl.stroke()
  // targets: filled in view, hollow from memory; beyond the edge a triangle on the frame with the distance
  let inView = Set(targets.map { $0.0 })
  var edgeLabels: [NSRect] = []
  // far boats: only the 3 nearest get their distance written on the edge, the rest are just triangles
  let farIds = Set(memory.filter { now - $0.value.t <= 60 && hypot($0.value.e, $0.value.n) * k > halfH - 14 }
    .sorted { hypot($0.value.e, $0.value.n) < hypot($1.value.e, $1.value.n) }.prefix(3).map { $0.key })
  for (id, mm) in memory {
    let age = now - mm.t
    if age > 60 { continue }
    let dist = hypot(mm.e, mm.n), ru = up(mm.e, mm.n), x = ru.0 * k, y = ru.1 * k
    let col = (mm.ahead ? green : red), alpha = inView.contains(id) ? 1 : max(0.3, 1 - age / 60)
    if abs(x) > halfW - 14 || abs(y) > halfH - 14 {
      let f = min((halfW - 16) / max(abs(x), 1e-6), (halfH - 16) / max(abs(y), 1e-6)), p = NSPoint(x: cx + x * f, y: cy + y * f)
      let ux = x / hypot(x, y), uy = y / hypot(x, y)
      let tri = NSBezierPath(); tri.move(to: NSPoint(x: p.x + ux * 12, y: p.y + uy * 12)); tri.line(to: NSPoint(x: p.x - uy * 9, y: p.y + ux * 9)); tri.line(to: NSPoint(x: p.x + uy * 9, y: p.y - ux * 9)); tri.close()
      col.withAlphaComponent(alpha).setFill(); tri.fill()
      if farIds.contains(id) {
        let lt = text(String(format: "%.0f m", dist), 20, .semibold, .white)
        var lr = NSRect(x: p.x - ux * 60 - lt.size().width / 2, y: p.y - uy * 40 - 10, width: lt.size().width, height: 24)
        var tries = 0
        while edgeLabels.contains(where: { $0.intersects(lr) }) && tries < 6 { lr.origin.x += uy == 0 ? 0 : 70; lr.origin.y += uy > 0 ? -26 : 26; tries += 1 }
        edgeLabels.append(lr); lt.draw(at: lr.origin)
      }
      continue
    }
    let r = NSRect(x: cx + x - 10, y: cy + y - 10, width: 20, height: 20)
    if inView.contains(id) { col.setFill(); NSBezierPath(ovalIn: r).fill() }
    else { let o = NSBezierPath(ovalIn: r); o.lineWidth = 3; col.withAlphaComponent(alpha).setStroke(); o.stroke() }
  }
  NSGraphicsContext.restoreGraphicsState()
  // our boat on the parity line, heading relative to the wind
  let L = 30.0, Bm = 11.0, h = (HDG - TWD) * .pi / 180
  func rot(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: cx + x * cos(h) + y * sin(h), y: cy - x * sin(h) + y * cos(h)) }
  let hull = NSBezierPath(); hull.move(to: rot(0, L)); hull.line(to: rot(Bm, -L * 0.6)); hull.line(to: rot(-Bm, -L * 0.6)); hull.close()
  NSColor.white.setFill(); hull.fill()
  // wind arrow from the top edge, and the north
  let gold = NSColor(calibratedRed: 1, green: 0.8, blue: 0.2, alpha: 1)
  let wa = NSBezierPath(); wa.move(to: NSPoint(x: cx, y: Double(plot.maxY) + 4)); wa.line(to: NSPoint(x: cx, y: Double(plot.maxY) - 44)); wa.lineWidth = 6; gold.setStroke(); wa.stroke()
  let head = NSBezierPath(); head.move(to: NSPoint(x: cx, y: Double(plot.maxY) - 58)); head.line(to: NSPoint(x: cx - 11, y: Double(plot.maxY) - 38)); head.line(to: NSPoint(x: cx + 11, y: Double(plot.maxY) - 38)); head.close(); gold.setFill(); head.fill()
  let nr = up(0, 1)
  let na = NSBezierPath(); let nx = Double(plot.maxX) - 46, ny = Double(plot.maxY) - 46
  na.move(to: NSPoint(x: nx - nr.0 * 20, y: ny - nr.1 * 20)); na.line(to: NSPoint(x: nx + nr.0 * 20, y: ny + nr.1 * 20)); na.lineWidth = 3; NSColor(white: 1, alpha: 0.7).setStroke(); na.stroke()
  text("N", 20, .bold, NSColor(white: 1, alpha: 0.8)).draw(at: NSPoint(x: nx + nr.0 * 30 - 7, y: ny + nr.1 * 30 - 11))
  // header of the section
  let hy = secY + secH - 54
  text(String(format: "TWD %03.0f°", TWD), 28, .bold, gold).draw(at: NSPoint(x: 30, y: hy))
  text(String(format: "HDG %03.0f°", HDG), 28, .bold, .white).draw(at: NSPoint(x: 230, y: hy))
  text("vento in alto · parità ⟂ TWD · 150 m al bordo", 22, .regular, NSColor(white: 1, alpha: 0.7)).draw(at: NSPoint(x: 430, y: hy + 4))
}
// when the parity line is out of the picture: an arrow on the edge, towards the nearer end of the line
func parityHint(cam: Double, hz: Double) {
  func rel(_ b: Double) -> Double { var r = (b - cam).truncatingRemainder(dividingBy: 360); if r > 180 { r -= 360 }; if r < -180 { r += 360 }; return r }
  let r1 = rel(TWD + 90), r2 = rel(TWD - 90), r = abs(r1) < abs(r2) ? r1 : r2
  let half = atan(Double(W) / 2 / FOCAL) * 180 / .pi
  guard abs(r) > half else { return }
  let t = text(r < 0 ? String(format: "◀ parità %.0f°", abs(r)) : String(format: "parità %.0f° ▶", abs(r)), 34, .bold, .white)
  let w = t.size().width + 24, y = Double(H) - hz - 110
  let x = r < 0 ? 12.0 : Double(W) - w - 12
  NSColor.black.withAlphaComponent(0.6).setFill(); NSRect(x: x, y: y, width: w, height: 48).fill()
  t.draw(at: NSPoint(x: x + 12, y: y + 6))
}
// where a point on the sea (east e, north n metres from the phone) shows in the picture; nil if behind the camera
func project(_ e: Double, _ n: Double, cam: Double, hz: Double) -> NSPoint? {
  let d = hypot(e, n); if d < 0.5 { return nil }
  let b = atan2(e, n) * 180 / .pi
  var rel = (b - cam).truncatingRemainder(dividingBy: 360); if rel > 180 { rel -= 360 }; if rel < -180 { rel += 360 }
  if abs(rel) > 85 { return nil }
  let r = rel * .pi / 180, dip = atan(CAMH / d)
  let x = Double(W) / 2 + FOCAL * tan(r), y = hz + FOCAL * tan(dip) / cos(r)
  return NSPoint(x: x, y: Double(H) - y)
}
// BOW: metres from the phone forward to the bow; the ladder lines are drawn through the bow, square to TWD,
// from right in front of us out to the horizon on both sides (the screen edges cut them, nothing else)
let BOW = Double(kv["bow"] ?? "4")!
func drawLadder(cam: Double, hz: Double) -> Bool {
  let tw = TWD * .pi / 180, wU = (sin(tw), cos(tw)), wP = (sin(tw + .pi / 2), cos(tw + .pi / 2))
  let hd = HDG * .pi / 180, bow = (BOW * sin(hd), BOW * cos(hd))
  // along the line: dense close to us, sparse far away, out to 50 km so it meets the horizon
  var steps: [Double] = [0]; var v = 0.25; while v < 50000 { steps.append(v); steps.append(-v); v *= 1.06 }
  steps.sort()
  var seen = false
  for L in leads {
    let u = DOWN ? L : -L                                   // metres upwind of us for a boat with our lead L
    let col: NSColor = L == 0 ? .white : (L > 0 ? green : red)
    var path: [NSPoint] = [], label: NSPoint? = nil
    func flush() {
      if path.count > 1 {
        let p = NSBezierPath(); p.move(to: path[0]); for q in path.dropFirst() { p.line(to: q) }
        p.lineWidth = L == 0 ? 6 : 3
        if L == 0 { p.setLineDash([26, 14], count: 2, phase: 0) }
        NSColor.black.withAlphaComponent(0.35).setStroke(); let sh = p.copy() as! NSBezierPath; sh.lineWidth = p.lineWidth + 4; sh.stroke()
        col.withAlphaComponent(0.95).setStroke(); p.stroke()
      }
      path = []
    }
    for sAlong in steps {
      let e = bow.0 + u * wU.0 + sAlong * wP.0, n = bow.1 + u * wU.1 + sAlong * wP.1
      if let q = project(e, n, cam: cam, hz: hz) {
        path.append(q)
        if q.x > 30, q.x < Double(W) - 190, q.y > 110, q.y < Hf0 - 200 {
          seen = true
          if label == nil || q.y > label!.y { label = q }      // the visible point nearest the horizon
        }
      } else { flush() }
    }
    flush()
    if let b = label {
      let t = text(L == 0 ? "parità" : (L > 0 ? "+" : "−") + String(format: "%.0f", abs(L)), 30, .bold, col)
      NSColor.black.withAlphaComponent(0.55).setFill(); NSRect(x: b.x + 8, y: b.y - 46, width: t.size().width + 14, height: 40).fill()
      t.draw(at: NSPoint(x: b.x + 15, y: b.y - 42))
    }
  }
  return seen
}

var n = 0
let total = Int(dur * fps)
while n < total {
  let t = Double(n) / fps
  guard let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) else { n += 1; continue }
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  CVPixelBufferLockBaseAddress(pb!, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb!), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb!),
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  let Hf = CGFloat(H)
  if LADDER, let c0 = camAz(t), let hz0 = horizonY(cg) ?? hzS {
    let (c, hz) = damp(c0, hz0)
    let visible = drawLadder(cam: c, hz: hz)
    if leads == [0] && !visible { parityHint(cam: c, hz: hz) }
    if leads == [0] {
      let tg: [(Int, Double, Double, Bool)] = data.tracks.compactMap { tr in at(tr, t).map { v in (tr.id, sin(v.brg * .pi / 180) * v.dist, cos(v.brg * .pi / 180) * v.dist, v.lead >= 0) } }
      topView(cam: c, targets: tg, now: t)
    }
  }
  // top bar: own boat data from the instruments
  NSColor.black.withAlphaComponent(0.6).setFill(); NSRect(x: 0, y: Hf - 150, width: CGFloat(W), height: 150).fill()
  text("MaxRace · TARGETS", 30, .bold, .white).draw(at: NSPoint(x: 30, y: Hf - 58))
  text(String(format: "HDG %03.0f°  TWD %03.0f°  TWA %.0f°  BSP %.1f  %@ %@", HDG, TWD, TWA, BSP, DOWN ? "poppa, gennaker," : "bolina,", PORT ? "mure a sinistra" : "mure a dritta"), 30, .semibold, NSColor(white: 0.9, alpha: 1)).draw(at: NSPoint(x: 30, y: Hf - 116))
  if let c = LADDER ? (camS ?? camAz(t)) : camAz(t) {
    let rel = (c - HDG + 540).truncatingRemainder(dividingBy: 360) - 180
    // wind from port on port tack/gybe: port side is windward
    let lee = PORT ? "sottovento" : "sopravento", wind = PORT ? "sopravento" : "sottovento"
    let side = abs(rel) < 25 ? "verso prua" : abs(rel) > 155 ? "verso poppa" : rel > 0 ? (abs(rel) < 70 ? "prua a dritta" : abs(rel) <= 110 ? "traverso a dritta" : "poppa a dritta") + " (\(lee))" : (abs(rel) < 70 ? "prua a sinistra" : abs(rel) <= 110 ? "traverso a sinistra" : "poppa a sinistra") + " (\(wind))"
    text(String(format: "bussola telefono %03.0f° · %@", c, side), 24, .regular, NSColor(white: 0.75, alpha: 1)).draw(at: NSPoint(x: CGFloat(W) - 560, y: Hf - 58))
  }
  // nearest boats first; a label never covers another one: full label, else a small one, else the box alone
  var placed: [NSRect] = []
  let shown = data.tracks.compactMap { tr in at(tr, t).map { (tr.id, $0) } }.sorted { $0.1.dist < $1.1.dist }
  for (n, (id, v)) in shown.enumerated() {
    let b = v.box, ahead = v.lead >= 0, col = ahead ? green : red
    let r = NSRect(x: b[0], y: Double(H) - b[1] - b[3], width: b[2], height: b[3])
    col.setStroke(); let path = NSBezierPath(rect: r); path.lineWidth = b[3] < 60 ? 4 : 6; path.stroke()
    let lead = abs(v.lead) < 1 ? "pari" : (ahead ? "+" : "−") + String(format: "%.0f m", abs(v.lead))
    let variants: [(NSAttributedString, NSAttributedString?, CGFloat)] = n < 6
      ? [(text(lead, 64, .heavy, col), text(String(format: "T%d · %.0f m · %03.0f°", id, v.dist, v.brg), 30, .medium, .white), 118), (text(lead, 34, .heavy, col), nil, 48)]
      : [(text(lead, 34, .heavy, col), nil, 48)]
    var done = false
    for (l1, l2, th) in variants where !done {
      let tw = max(l1.size().width, l2?.size().width ?? 0) + 24
      var tx = max(0, r.midX - tw / 2); if tx + tw > CGFloat(W) { tx = CGFloat(W) - tw }
      for ty in [r.maxY + 10, r.minY - th - 10, r.maxY + 10 + th + 6] {
        let lr = NSRect(x: tx, y: ty, width: tw, height: th)
        if ty < 92 + 700 + 10 || ty + th > Hf - 160 || placed.contains(where: { $0.intersects(lr) }) { continue }
        NSColor.black.withAlphaComponent(0.72).setFill(); lr.fill()
        if let l2 = l2 { l1.draw(at: NSPoint(x: tx + 12, y: ty + 40)); l2.draw(at: NSPoint(x: tx + 12, y: ty + 8)) }
        else { l1.draw(at: NSPoint(x: tx + 12, y: ty + 4)) }
        placed.append(lr); done = true; break
      }
    }
  }
  // legend
  NSColor.black.withAlphaComponent(0.6).setFill(); NSRect(x: 0, y: 0, width: CGFloat(W), height: 92).fill()
  text("verde: sei avanti   ·   rosso: sei dietro", 32, .semibold, .white).draw(at: NSPoint(x: 30, y: 46))
  text(DOWN ? "di poppa: avanti chi è più sottovento · linee di scala sulla TWD" : "di bolina: avanti chi è più sopravento · linee di scala sulla TWD", 26, .regular, NSColor(white: 0.75, alpha: 1)).draw(at: NSPoint(x: 30, y: 12))
  NSGraphicsContext.restoreGraphicsState()
  CVPixelBufferUnlockBaseAddress(pb!, [])
  while !input.isReadyForMoreMediaData { usleep(2000) }
  adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(n), timescale: CMTimeScale(fps)))
  n += 1
}
input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
print("done", n, "frames", writer.status.rawValue, writer.error?.localizedDescription ?? "")
