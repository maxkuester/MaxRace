// Draws the MaxRace logo (build/logo.svg, same shapes) into every icon the apps need:
//   swift scripts/render-icon.swift   (from the repo folder)
import AppKit

let bg = NSColor(srgbRed: 0x11/255.0, green: 0x13/255.0, blue: 0x15/255.0, alpha: 1)
let white = NSColor(srgbRed: 0xF2/255.0, green: 0xF4/255.0, blue: 0xF6/255.0, alpha: 1)
let red = NSColor(srgbRed: 0xE3/255.0, green: 0x24/255.0, blue: 0x2B/255.0, alpha: 1)
// the M in a 160 x 160 square, centred on (80, 82)
let shapes: [([(CGFloat, CGFloat)], NSColor)] = [
    // red first, white a hair over it in the middle so no seam shows where they meet
    ([(132,32),(118,32),(80,102),(80,132),(118,60),(118,62),(105,128),(132,128)], red),
    ([(28,32),(42,32),(80.4,102.7),(80.4,132.8),(42,60),(42,62),(55,128),(28,128)], white),
]
enum Back { case none, square, rounded(CGFloat), circle }

// size px; back: what is behind the M; mScale: the M's size against the 160 design (1 = as designed)
func render(_ size: Int, _ back: Back, mScale: CGFloat = 1, inset: CGFloat = 0) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(size), box = NSRect(x: inset * s, y: inset * s, width: s * (1 - 2 * inset), height: s * (1 - 2 * inset))
    switch back {
    case .none: break
    case .square: bg.setFill(); NSBezierPath(rect: box).fill()
    case .rounded(let r): bg.setFill(); NSBezierPath(roundedRect: box, xRadius: box.width * r, yRadius: box.width * r).fill()
    case .circle: bg.setFill(); NSBezierPath(ovalIn: box).fill()
    }
    let k = box.width / 160 * mScale
    for (pts, col) in shapes {
        let p = NSBezierPath()
        for (i, (x, y)) in pts.enumerated() {
            // design y goes down, AppKit y goes up; scale about the M's centre (80, 82)
            let px = box.midX + (x - 80) * k, py = box.midY - (y - 82) * k
            if i == 0 { p.move(to: NSPoint(x: px, y: py)) } else { p.line(to: NSPoint(x: px, y: py)) }
        }
        p.close(); col.setFill(); p.fill()
    }
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}
func write(_ path: String, _ d: Data) { try! d.write(to: URL(fileURLWithPath: path)); print("  " + path) }

// iOS: one 1024 square, no transparency, iOS rounds the corners itself
let ios = render(1024, .square)
let src = NSBitmapImageRep(data: ios)!.cgImage!
let cg = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                   bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
cg.draw(src, in: CGRect(x: 0, y: 0, width: 1024, height: 1024))
write("native/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png", NSBitmapImageRep(cgImage: cg.makeImage()!).representation(using: .png, properties: [:])!)
// computer program and home-screen web icon: rounded square with a small margin, like a Mac app
write("build/icon.png", render(1024, .rounded(0.225), inset: 0.04))
write("build/icon-256.png", render(256, .rounded(0.225), inset: 0.04))   // packed into build/icon.ico for Windows
// Android: legacy square and round icons, and the adaptive foreground (108 dp, safe circle 66 dp)
let res = "native/android/app/src/main/res/"
for (d, px) in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)] {
    write(res + "mipmap-\(d)/ic_launcher.png", render(px, .rounded(0.2), inset: 0.04))
    write(res + "mipmap-\(d)/ic_launcher_round.png", render(px, .circle, mScale: 0.9, inset: 0.04))
    write(res + "mipmap-\(d)/ic_launcher_foreground.png", render(px * 108 / 48, .none, mScale: 0.62))
}
