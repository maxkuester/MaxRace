// Pulls dark detail out of a backlit picture: lower exposure, lift shadows, more contrast and sharpness.
import AppKit
import CoreImage
let inp = CIImage(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))!
var img = inp.applyingFilter("CIExposureAdjust", parameters: ["inputEV": Double(CommandLine.arguments[3]) ?? -1.0])
img = img.applyingFilter("CIHighlightShadowAdjust", parameters: ["inputHighlightAmount": 0.2, "inputShadowAmount": 1.0])
img = img.applyingFilter("CIColorControls", parameters: ["inputContrast": 1.7, "inputSaturation": 0.0])
img = img.applyingFilter("CISharpenLuminance", parameters: ["inputSharpness": 0.8])
let ctx = CIContext(), cg = ctx.createCGImage(img, from: inp.extent)!
try! NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
