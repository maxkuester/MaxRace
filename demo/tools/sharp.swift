// Finds the sharpest frames of a region of the video (gradient energy) and saves them enlarged.
import AVFoundation
import AppKit
let a = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let t0 = Double(a[2])!, t1 = Double(a[3])!, out = a[4]
let r = a[5].split(separator: ",").map { Int($0)! }          // x,y,w,h in the 1080x1920 frame
let gen = AVAssetImageGenerator(asset: asset); gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
var scores: [(Double, Double, CGImage)] = []
var t = t0
while t <= t1 {
  if let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil),
     let c = cg.cropping(to: CGRect(x: r[0], y: r[1], width: r[2], height: r[3])) {
    let w = c.width, h = c.height
    let px = UnsafeMutablePointer<UInt8>.allocate(capacity: w * h * 4); defer { px.deallocate() }
    let ctx = CGContext(data: px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.draw(c, in: CGRect(x: 0, y: 0, width: w, height: h))
    var e = 0.0
    for y in 1..<(h - 1) { for x in 1..<(w - 1) {
      let k = (y * w + x) * 4, l = Double(px[k]) + Double(px[k + 1]) + Double(px[k + 2])
      let gx = l - Double(px[k + 4]) - Double(px[k + 5]) - Double(px[k + 6]), gy = l - Double(px[k + w * 4]) - Double(px[k + w * 4 + 1]) - Double(px[k + w * 4 + 2])
      e += gx * gx + gy * gy } }
    scores.append((e / Double(w * h), t, c))
  }
  t += 1.0 / 30
}
scores.sort { $0.0 > $1.0 }
for (i, s) in scores.prefix(3).enumerated() {
  let big = NSImage(size: NSSize(width: s.2.width * 6, height: s.2.height * 6))
  big.lockFocus(); NSGraphicsContext.current?.imageInterpolation = .high
  NSImage(cgImage: s.2, size: .zero).draw(in: NSRect(x: 0, y: 0, width: s.2.width * 6, height: s.2.height * 6)); big.unlockFocus()
  try! NSBitmapImageRep(data: big.tiffRepresentation!)!.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)-\(i + 1).png"))
  print(String(format: "%d: t=%.2fs nitidezza %.0f", i + 1, s.1, s.0))
}
