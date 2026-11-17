// Reads the labels already drawn on the demo video ("T3 · 98 m · 142°" with "−17 m" above) at 5 frames a second.
import AVFoundation
import Vision
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let a = AVURLAsset(url: url)
let dur = CMTimeGetSeconds(a.duration)
let g = AVAssetImageGenerator(asset: a); g.appliesPreferredTrackTransform = true
g.requestedTimeToleranceBefore = .zero; g.requestedTimeToleranceAfter = .zero
var out: [String] = []
var t = 0.0
let re = try! NSRegularExpression(pattern: "T\\s?(\\d+)\\s*[·.•]\\s*(\\d+)\\s*m\\s*[·.•]\\s*(\\d+)")
let reL = try! NSRegularExpression(pattern: "^([+\\-−–])\\s?(\\d+)\\s*m$")
while t < dur - 0.05 {
  guard let cg = try? g.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) else { t += 0.2; continue }
  let W = Double(cg.width), H = Double(cg.height)
  let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.usesLanguageCorrection = false
  try! VNImageRequestHandler(cgImage: cg).perform([req])
  var items: [(String, CGRect)] = []
  for o in req.results ?? [] { if let c = o.topCandidates(1).first { let b = o.boundingBox
    items.append((c.string, CGRect(x: b.minX * W, y: (1 - b.maxY) * H, width: b.width * W, height: b.height * H))) } }
  var labs: [String] = []
  for (s, r) in items {
    let ns = s as NSString
    guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { continue }
    let id = ns.substring(with: m.range(at: 1)), dist = ns.substring(with: m.range(at: 2)), brg = ns.substring(with: m.range(at: 3))
    // the lead: the +/− metres just above this line
    var lead = "null"
    for (s2, r2) in items where r2.maxY <= r.minY + 6 && r2.maxY > r.minY - 120 && abs(r2.minX - r.minX) < 60 {
      let n2 = s2.replacingOccurrences(of: " ", with: "") as NSString
      if let m2 = reL.firstMatch(in: n2 as String, range: NSRange(location: 0, length: n2.length)) {
        let sg = n2.substring(with: m2.range(at: 1)) == "+" ? 1 : -1
        lead = String(sg * Int(n2.substring(with: m2.range(at: 2)))!)
      }
    }
    labs.append(String(format: "{\"id\":%@,\"dist\":%@,\"brg\":%@,\"lead\":%@,\"x\":%.0f,\"y\":%.0f,\"w\":%.0f,\"h\":%.0f}", id, dist, brg, lead, r.minX, r.minY, r.width, r.height))
  }
  out.append(String(format: "{\"t\":%.2f,\"labs\":[%@]}", t, labs.joined(separator: ",")))
  t += 0.2
}
try! ("{\"dur\":\(dur),\"frames\":[" + out.joined(separator: ",\n") + "]}").write(toFile: CommandLine.arguments[2], atomically: true, encoding: .utf8)
print(out.count, "frames read, video", dur, "s")
