// Adds the "if we tack now" margin over the MaxRace target demo, plus the spoken question and answer, and the voice.
//   swift overlay.swift in.mp4 labels-m.json risposta.wav out.mp4
import AVFoundation
import AppKit
import CoreText

struct Lab: Decodable { let id: Int; let dist: Double; let brg: Double; let x: Double; let y: Double; let w: Double; let h: Double; let margin: Double? }
struct Fr: Decodable { let t: Double; let labs: [Lab] }
struct J: Decodable { let frames: [Fr]; let med: [String: Double] }
let A = CommandLine.arguments
let J0 = try! JSONDecoder().decode(J.self, from: Data(contentsOf: URL(fileURLWithPath: A[2])))
let BL = 9.6, qT = 0.4, aT = 1.5          // question at 0.4 s, answer from 1.5 s
let audioURL = URL(fileURLWithPath: A[3])
let audioDur = CMTimeGetSeconds(AVURLAsset(url: audioURL).duration)

func fmtL(_ m: Double) -> String {
  let l = abs(m) / BL, h = (l * 2).rounded() / 2
  let s = h < 10 ? (h == h.rounded() ? String(Int(h)) : String(format: "%.1f", h).replacingOccurrences(of: ".", with: ",")) : String(Int(l.rounded()))
  return (m > 0 ? "+" : "−") + s + "L"
}
func text(_ c: CGContext, _ s: String, _ x: CGFloat, _ yTop: CGFloat, _ size: CGFloat, _ col: NSColor, _ H: CGFloat, bold: Bool = true) -> CGSize {
  let f = NSFont.systemFont(ofSize: size, weight: bold ? .bold : .medium)
  let a = NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: col])
  let line = CTLineCreateWithAttributedString(a), b = CTLineGetBoundsWithOptions(line, [])
  c.textPosition = CGPoint(x: x, y: H - yTop - f.ascender); CTLineDraw(line, c)
  return b.size
}
func pill(_ c: CGContext, _ r: CGRect, _ col: NSColor, _ H: CGFloat) {
  let rr = CGRect(x: r.minX, y: H - r.maxY, width: r.width, height: r.height)
  c.setFillColor(col.cgColor); c.addPath(CGPath(roundedRect: rr, cornerWidth: 10, cornerHeight: 10, transform: nil)); c.fillPath()
}

let src = AVURLAsset(url: URL(fileURLWithPath: A[1]))
let vt = src.tracks(withMediaType: .video)[0]
let reader = try! AVAssetReader(asset: src)
let ro = AVAssetReaderTrackOutput(track: vt, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(ro); reader.startReading()
let size = vt.naturalSize
let tmpURL = URL(fileURLWithPath: A[4] + ".video.mp4"); try? FileManager.default.removeItem(at: tmpURL)
let writer = try! AVAssetWriter(outputURL: tmpURL, fileType: .mp4)
let wi = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: size.width, AVVideoHeightKey: size.height,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]])
wi.transform = vt.preferredTransform
let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: wi, sourcePixelBufferAttributes: nil)
writer.add(wi); writer.startWriting(); writer.startSession(atSourceTime: .zero)
let red = NSColor(calibratedRed: 1, green: 0.36, blue: 0.36, alpha: 1), green = NSColor(calibratedRed: 0.24, green: 0.86, blue: 0.52, alpha: 1)
let dark = NSColor(calibratedWhite: 0, alpha: 0.72)
let answer = ["Virando:", "T1 passi dietro di 2 lunghezze e mezza", "T4 passi dietro di 3 lunghezze", "T3 passi dietro di 5 lunghezze"]

while let sb = ro.copyNextSampleBuffer() {
  let pts = CMSampleBufferGetPresentationTimeStamp(sb), t = CMTimeGetSeconds(pts)
  guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
  CVPixelBufferLockBaseAddress(pb, [])
  let W = CVPixelBufferGetWidth(pb), H = CVPixelBufferGetHeight(pb)
  let c = CGContext(data: CVPixelBufferGetBaseAddress(pb), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  let Hf = CGFloat(H)
  // the boats: the labels of the nearest read frame
  if let f = J0.frames.min(by: { abs($0.t - t) < abs($1.t - t) }), abs(f.t - t) < 0.25 {
    for l in f.labs where l.dist < 600 {
      // beside the label (its right side, or its left one near the edge), level with the big lead number
      let named = J0.med[String(l.id)] != nil && l.margin != nil, bw: CGFloat = named ? 300 : 340
      var x = CGFloat(l.x + l.w) + 34
      if x + bw > CGFloat(W) - 10 { x = CGFloat(l.x) - 30 - bw }
      let top = CGFloat(l.y) - 84
      if named, let m = J0.med[String(l.id)] {
        let col = abs(m) < 8 ? NSColor.systemYellow : (m > 0 ? green : red)
        pill(c, CGRect(x: x, y: top - 6, width: bw, height: 66), dark, Hf)
        _ = text(c, "↻ se viri " + fmtL(m), x + 14, top + 2, 40, col, Hf)
      } else {
        pill(c, CGRect(x: x, y: top - 6, width: bw, height: 56), dark, Hf)
        _ = text(c, "↻ virando non la incroci", x + 14, top + 6, 29, NSColor(calibratedWhite: 0.88, alpha: 1), Hf, bold: false)
      }
    }
  }
  // the question and the spoken answer, under the header
  // one band under the header: the question, then the line of the answer being spoken; what ↻ means in small
  pill(c, CGRect(x: 24, y: 162, width: CGFloat(W) - 48, height: 118), NSColor(calibratedWhite: 0, alpha: 0.68), Hf)
  if t >= qT {
    let k = t < aT ? -1 : min(3, Int((t - aT) / (audioDur / 4.0)))
    _ = text(c, "🎙 «Se viro?»", 44, 172, 34, .white, Hf)
    if k >= 0 { _ = text(c, answer[k], 300, 174, 32, k == 0 ? .white : red, Hf) }
  }
  _ = text(c, "↻ se viri ora: rotta 180°, 6 s persi in virata, margine in lunghezze di Cape 31", 44, 230, 25, NSColor(calibratedWhite: 0.85, alpha: 1), Hf, bold: false)
  CVPixelBufferUnlockBaseAddress(pb, [])
  while !wi.isReadyForMoreMediaData { usleep(2000) }
  ad.append(pb, withPresentationTime: pts)
}
wi.markAsFinished()
let sem = DispatchSemaphore(value: 0); writer.finishWriting { sem.signal() }; sem.wait()

// the voice: the answer starts at aT
let comp = AVMutableComposition(), v2 = AVURLAsset(url: tmpURL), vtr = v2.tracks(withMediaType: .video)[0]
let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try! cv.insertTimeRange(CMTimeRange(start: .zero, duration: v2.duration), of: vtr, at: .zero); cv.preferredTransform = vtr.preferredTransform
let au = AVURLAsset(url: audioURL), atr = au.tracks(withMediaType: .audio)[0]
let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
let room = CMTimeSubtract(v2.duration, CMTime(seconds: aT, preferredTimescale: 600))
try! ca.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(au.duration, room)), of: atr, at: CMTime(seconds: aT, preferredTimescale: 600))
let outURL = URL(fileURLWithPath: A[4]); try? FileManager.default.removeItem(at: outURL)
let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetHighestQuality)!
ex.outputURL = outURL; ex.outputFileType = .mp4
let s2 = DispatchSemaphore(value: 0); ex.exportAsynchronously { s2.signal() }; s2.wait()
print("export", ex.status.rawValue, ex.error?.localizedDescription ?? "ok", "audio", audioDur, "video", CMTimeGetSeconds(v2.duration))
try? FileManager.default.removeItem(at: tmpURL)
