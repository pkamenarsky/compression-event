// The home-screen icon: "CE" in the game's own face, white on black.
//
//   swift scripts/icon.swift
//
// Writes public/icon-512.png, public/icon-192.png and public/apple-touch-icon.png
// (180). The letters stay inside the middle 60%, which is what Android keeps of
// a maskable icon whatever shape it cuts it to.

import AppKit
import CoreText

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let fontURL = root.appendingPathComponent("assets/asteroids-display.otf")

guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(fontURL as CFURL) as? [CTFontDescriptor],
      let descriptor = descriptors.first else {
  fatalError("could not read \(fontURL.path)")
}

func render(size: Int, to name: String) {
  let s = CGFloat(size)
  let space = CGColorSpaceCreateDeviceRGB()

  guard let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { fatalError("no context") }

  ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))

  // Sized by measuring at 100 and scaling, so the word fills the safe zone
  // whatever the face's own proportions are.
  let probe = CTFontCreateWithFontDescriptor(descriptor, 100, nil)
  let text = "CE"

  func line(_ font: CTFont) -> CTLine {
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
    ]
    return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
  }

  let measured = CTLineGetImageBounds(line(probe), ctx)
  let scale = min(s * 0.6 / measured.width, s * 0.6 / measured.height)
  let font = CTFontCreateWithFontDescriptor(descriptor, 100 * scale, nil)
  let l = line(font)
  let bounds = CTLineGetImageBounds(l, ctx)

  // The face is drawn in hairlines, which vanish at 180 pixels; stroked over
  // as well, they hold up at every size an icon is shown at.
  ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  ctx.setLineWidth(s * 0.018)
  ctx.setLineJoin(.miter)
  ctx.setTextDrawingMode(.fillStroke)

  ctx.textPosition = CGPoint(x: (s - bounds.width) / 2 - bounds.minX, y: (s - bounds.height) / 2 - bounds.minY)
  CTLineDraw(l, ctx)

  let image = ctx.makeImage()!
  let rep = NSBitmapImageRep(cgImage: image)
  let data = rep.representation(using: .png, properties: [:])!
  try! data.write(to: root.appendingPathComponent("public/\(name)"))
}

render(size: 512, to: "icon-512.png")
render(size: 192, to: "icon-192.png")
render(size: 180, to: "apple-touch-icon.png")
