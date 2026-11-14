import AVFoundation
import AppKit
let url = URL(fileURLWithPath: CommandLine.arguments[1]), out = CommandLine.arguments[2], step = Double(CommandLine.arguments[3])!
let asset = AVURLAsset(url: url)
let dur = CMTimeGetSeconds(asset.duration)
let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
var list: [String] = []
var t = 0.0, i = 0
while t < dur - 0.02 {
  if let cg = try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) {
    let data = NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.85])!
    let name = String(format: "f%03d.jpg", i)
    try! data.write(to: URL(fileURLWithPath: "\(out)/\(name)"))
    list.append("{\"t\":\(String(format: "%.3f", t)),\"src\":\"\(CommandLine.arguments[4])/\(name)\"}")
  }
  t += step; i += 1
}
try! ("[" + list.joined(separator: ",") + "]").write(toFile: "\(out)/../frames.json", atomically: true, encoding: .utf8)
print(list.count, "frames")
