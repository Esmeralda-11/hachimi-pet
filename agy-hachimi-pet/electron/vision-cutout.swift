import Foundation
import Vision
import CoreImage
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct Job: Decodable {
    let input: String
    let output: String
    let allowMultiple: Bool?
}

struct JobResult: Encodable {
    let output: String
    let ok: Bool
    let instances: Int
    let fgRatio: Double
    let error: String?
}

func loadCGImageOriented(url: URL) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: 2048
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
        ?? CGImageSourceCreateImageAtIndex(src, 0, nil)
}

@inline(__always)
func sampleMaskAlpha(_ buf: CVPixelBuffer, x: Int, y: Int, fmt: OSType, base: UnsafeMutableRawPointer, bpr: Int) -> Float {
    if fmt == kCVPixelFormatType_OneComponent32Float {
        let row = (base + y * bpr).assumingMemoryBound(to: Float32.self)
        return min(1.0, max(0.0, row[x]))
    } else if fmt == kCVPixelFormatType_OneComponent16Half {
        let row = (base + y * bpr).assumingMemoryBound(to: UInt16.self)
        #if arch(arm64)
        let h = Float16(bitPattern: row[x])
        return min(1.0, max(0.0, Float(h)))
        #else
        return row[x] > 0x3800 ? 1.0 : 0.0
        #endif
    } else {
        let row = (base + y * bpr).assumingMemoryBound(to: UInt8.self)
        return Float(row[x]) / 255.0
    }
}

func processOne(_ job: Job) -> JobResult {
    let inUrl = URL(fileURLWithPath: job.input)
    let outUrl = URL(fileURLWithPath: job.output)
    guard let cgImg = loadCGImageOriented(url: inUrl) else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "load_failed")
    }

    let w = cgImg.width
    let h = cgImg.height
    guard w > 4 && h > 4 else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "too_small")
    }

    guard #available(macOS 14.0, *) else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "macos_14_required")
    }

    let req = VNGenerateForegroundInstanceMaskRequest()
    let handler = VNImageRequestHandler(cgImage: cgImg, options: [:])
    do {
        try handler.perform([req])
    } catch {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "vision_failed")
    }

    guard let obs = req.results?.first, !obs.allInstances.isEmpty else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "no_foreground")
    }

    var chosenInstances = obs.allInstances
    if job.allowMultiple != true && obs.allInstances.count > 1 {
        var bestScore = -1.0
        var bestIdx = obs.allInstances.first!
        var instanceScores: [(Int, Double, Double, Bool)] = []

        for idx in obs.allInstances {
            if let maskBuf = try? obs.generateScaledMaskForImage(forInstances: IndexSet(integer: idx), from: handler) {
                CVPixelBufferLockBaseAddress(maskBuf, .readOnly)
                let mw = CVPixelBufferGetWidth(maskBuf)
                let mh = CVPixelBufferGetHeight(maskBuf)
                let bpr = CVPixelBufferGetBytesPerRow(maskBuf)
                let fmt = CVPixelBufferGetPixelFormatType(maskBuf)
                if let base = CVPixelBufferGetBaseAddress(maskBuf) {
                    var count = 0
                    var sumX = 0.0
                    var sumY = 0.0
                    var borderHits = 0
                    let step = max(1, min(mw, mh) / 256)
                    for y in stride(from: 0, to: mh, by: step) {
                        for x in stride(from: 0, to: mw, by: step) {
                            let v = sampleMaskAlpha(maskBuf, x: x, y: y, fmt: fmt, base: base, bpr: bpr)
                            if v > 0.38 {
                                count += 1
                                sumX += Double(x) / Double(mw)
                                sumY += Double(y) / Double(mh)
                                if x <= step || x >= mw - 1 - step || y <= step {
                                    borderHits += 1
                                }
                            }
                        }
                    }
                    if count > 0 {
                        let cx = sumX / Double(count)
                        let cy = sumY / Double(count)
                        let distCenter = hypot(cx - 0.5, cy - 0.52)
                        let areaFrac = Double(count * step * step) / Double(mw * mh)
                        let borderFrac = Double(borderHits) / Double(max(1, count))
                        let centrality = max(0.15, 1.15 - distCenter * 1.45)
                        let borderPenalty = borderFrac > 0.25 ? 0.35 : 1.0
                        let score = pow(areaFrac, 0.65) * centrality * borderPenalty
                        instanceScores.append((idx, score, areaFrac, borderFrac > 0.25))
                        if score > bestScore {
                            bestScore = score
                            bestIdx = idx
                        }
                    }
                }
                CVPixelBufferUnlockBaseAddress(maskBuf, .readOnly)
            }
        }
        chosenInstances = IndexSet(integer: bestIdx)
        // Keep 2..4 similarly-sized non-border-clinging peers when input is a turnaround sheet!
        let cleanPeers = instanceScores.filter { !$0.3 && $0.2 >= 0.025 }
        if cleanPeers.count >= 2 && cleanPeers.count <= 4 {
            let maxA = cleanPeers.map { $0.2 }.max() ?? 1.0
            let balanced = cleanPeers.filter { $0.2 >= 0.36 * maxA }
            if balanced.count >= 2 {
                var multi = IndexSet()
                for b in balanced { multi.insert(b.0) }
                chosenInstances = multi
            }
        }
    }

    guard let maskBuf = try? obs.generateScaledMaskForImage(forInstances: chosenInstances, from: handler) else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "mask_gen_failed")
    }

    var rgba = [UInt8](repeating: 0, count: w * h * 4)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: &rgba,
        width: w,
        height: h,
        bitsPerComponent: 8,
        bytesPerRow: w * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "ctx_failed")
    }
    ctx.draw(cgImg, in: CGRect(x: 0, y: 0, width: w, height: h))

    CVPixelBufferLockBaseAddress(maskBuf, .readOnly)
    let mw = CVPixelBufferGetWidth(maskBuf)
    let mh = CVPixelBufferGetHeight(maskBuf)
    let mbpr = CVPixelBufferGetBytesPerRow(maskBuf)
    let mfmt = CVPixelBufferGetPixelFormatType(maskBuf)
    var fgCount = 0
    if let mbase = CVPixelBufferGetBaseAddress(maskBuf) {
        for y in 0..<h {
            let my = min(mh - 1, y * mh / h)
            for x in 0..<w {
                let mx = min(mw - 1, x * mw / w)
                let mf = sampleMaskAlpha(maskBuf, x: mx, y: my, fmt: mfmt, base: mbase, bpr: mbpr)
                let off = (y * w + x) * 4
                let origA = rgba[off + 3]
                if origA > 0 && mf > 0.035 {
                    let r = min(255, Int(rgba[off]) * 255 / Int(origA))
                    let g = min(255, Int(rgba[off + 1]) * 255 / Int(origA))
                    let b = min(255, Int(rgba[off + 2]) * 255 / Int(origA))
                    let finalA = min(255, max(0, Int((Float(origA) * mf).rounded())))
                    if finalA > 8 {
                        rgba[off] = UInt8((r * finalA) / 255)
                        rgba[off + 1] = UInt8((g * finalA) / 255)
                        rgba[off + 2] = UInt8((b * finalA) / 255)
                        rgba[off + 3] = UInt8(finalA)
                        if finalA > 32 { fgCount += 1 }
                    } else {
                        rgba[off] = 0; rgba[off + 1] = 0; rgba[off + 2] = 0; rgba[off + 3] = 0
                    }
                } else {
                    rgba[off] = 0; rgba[off + 1] = 0; rgba[off + 2] = 0; rgba[off + 3] = 0
                }
            }
        }
    }
    CVPixelBufferUnlockBaseAddress(maskBuf, .readOnly)

    guard let outImg = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(outUrl as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "save_failed")
    }
    CGImageDestinationAddImage(dest, outImg, nil)
    guard CGImageDestinationFinalize(dest) else {
        return JobResult(output: job.output, ok: false, instances: 0, fgRatio: 0, error: "finalize_failed")
    }

    let ratio = Double(fgCount) / Double(w * h)
    return JobResult(output: job.output, ok: true, instances: chosenInstances.count, fgRatio: ratio, error: nil)
}

let args = CommandLine.arguments
if args.count >= 2 {
    let jsonStr: String
    if args[1] == "-" {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        jsonStr = String(data: data, encoding: .utf8) ?? "[]"
    } else if FileManager.default.fileExists(atPath: args[1]),
              let s = try? String(contentsOfFile: args[1], encoding: .utf8) {
        jsonStr = s
    } else {
        jsonStr = args[1]
    }
    if let data = jsonStr.data(using: .utf8),
       let jobs = try? JSONDecoder().decode([Job].self, from: data) {
        let results = jobs.map { processOne($0) }
        if let outData = try? JSONEncoder().encode(results),
           let outStr = String(data: outData, encoding: .utf8) {
            print(outStr)
            exit(0)
        }
    }
}
print("[]")
exit(1)
