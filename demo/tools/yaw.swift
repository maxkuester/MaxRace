// Measures how much the phone turns between video frames: the far scene (horizon, boats) shifts sideways
// when the camera turns. Output: t and the turn since the start, in degrees (+ = to the right).
import AVFoundation
import Vision
import CoreImage
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let rate = 10.0, dur = CMTimeGetSeconds(asset.duration)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.maximumSize = CGSize(width: 540, height: 960)
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
let focal = 270.0 / tan(42.6 / 2 * .pi / 180)          // at 540 px wide
let ctx = CIContext()
// the band where the far scene is: find the horizon (bright sky over darker sea), take a strip around it
func band(_ cg: CGImage) -> CGImage {
  let w = cg.width, h = cg.height
  let bytes = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4); defer { bytes.deallocate() }
  let c = CGContext(data: bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
  var rows = [Double](repeating: 0, count: h)
  for y in 0..<h { var s = 0; for x in stride(from: 0, to: w, by: 4) { let k = (y * w + x) * 4; s += Int(bytes[k]) + Int(bytes[k + 1]) + Int(bytes[k + 2]) }; rows[y] = Double(s) }
  var best = -1e18, by = h / 2
  for y in Int(Double(h) * 0.15)..<Int(Double(h) * 0.85) { var a = 0.0, b = 0.0; for k in 1...8 { a += rows[y - k]; b += rows[min(h - 1, y + k)] }; if a - b > best { best = a - b; by = y } }
  // above the horizon only (sky, boats, coast, the horizon line): the water and the wake flow past and would fake a turn
  let top = max(0, by - Int(Double(h) * 0.10)), bot = min(h, by + Int(Double(h) * 0.06))
  return cg.cropping(to: CGRect(x: 0, y: top, width: w, height: bot - top))!
}
var prev: CGImage? = nil, total = 0.0, out: [String] = []
var t = 0.0
while t < dur - 0.02 {
  if let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) {
    let b = band(cg)
    if let p = prev, p.height == b.height || true {
      let req = VNTranslationalImageRegistrationRequest(targetedCGImage: p)
      try? VNImageRequestHandler(cgImage: b).perform([req])
      if let r = req.results?.first as? VNImageTranslationAlignmentObservation {
        let dx = Double(r.alignmentTransform.tx)
        let d = atan(dx / focal) * 180 / .pi
        if abs(d) < 25 { total += d }                    // more than 25 deg in 0.1 s is a failed match
      }
    }
    prev = b
    out.append("{\"t\":\(String(format: "%.2f", t)),\"turn\":\(String(format: "%.2f", total))}")
  }
  t += 1 / rate
}
print("[" + out.joined(separator: ",") + "]")
