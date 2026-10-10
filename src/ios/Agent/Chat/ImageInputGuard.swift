import Foundation
import ImageIO
import UniformTypeIdentifiers

/// [B5] read_image without a full decode first. A 500 MB file or a
/// 30000×30000 PNG used to be read into memory and decoded at full size
/// (several GB) before being shrunk — jetsam. This reads the header with
/// ImageIO, refuses what is unreasonable, and produces the model-sized JPEG
/// with ImageIO's thumbnail path, which never materialises the full bitmap.
enum ImageInputGuard {
    struct Probe: Equatable {
        let fileBytes: Int
        let pixelWidth: Int
        let pixelHeight: Int
        /// UTType identifier of the container (public.png, public.jpeg …).
        let typeIdentifier: String?

        var pixelCount: Double { Double(pixelWidth) * Double(pixelHeight) }
        var longEdge: Int { max(pixelWidth, pixelHeight) }
    }

    enum Decision: Equatable {
        case refuse(String)
        /// Decode through the thumbnail API to at most `maxPixelSize` on the long edge.
        case downsample(maxPixelSize: Int)
    }

    struct Prepared {
        let probe: Probe
        let jpegData: Data
        let width: Int
        let height: Int
    }

    /// Formats whose decoders can produce a reduced-size image without
    /// allocating the full bitmap first.
    static let subsamplingTypes: Set<String> = [
        UTType.jpeg.identifier, UTType.heic.identifier, UTType.heif.identifier,
        "public.heic", "public.heif", "public.jpeg",
    ]

    static func probe(url: URL) -> Probe? {
        let size = ToolResourceLimits.fileSize(at: url) ?? 0
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, options) else { return nil }
        return probe(source: source, fileBytes: size)
    }

    static func probe(data: Data) -> Probe? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options) else { return nil }
        return probe(source: source, fileBytes: data.count)
    }

    private static func probe(source: CGImageSource, fileBytes: Int) -> Probe? {
        guard CGImageSourceGetCount(source) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              w > 0, h > 0 else { return nil }
        return Probe(fileBytes: fileBytes, pixelWidth: w, pixelHeight: h,
                     typeIdentifier: CGImageSourceGetType(source) as String?)
    }

    static func decide(_ probe: Probe,
                       maxFileBytes: Int = ToolResourceLimits.maxImageFileBytes,
                       maxPixels: Int = ToolResourceLimits.maxImagePixels,
                       hardMaxPixels: Int = ToolResourceLimits.hardMaxImagePixels,
                       longEdge: Int = ToolResourceLimits.imageInferenceLongEdge) -> Decision {
        if probe.fileBytes > maxFileBytes {
            return .refuse("the file is \(probe.fileBytes / 1_048_576) MB; read_image accepts up to \(maxFileBytes / 1_048_576) MB")
        }
        let dims = "\(probe.pixelWidth)×\(probe.pixelHeight)"
        if probe.pixelCount > Double(hardMaxPixels) {
            return .refuse("the image is \(dims) pixels, too large to open on this device")
        }
        if probe.pixelCount > Double(maxPixels),
           !(probe.typeIdentifier.map { subsamplingTypes.contains($0) } ?? false) {
            return .refuse("the image is \(dims) pixels (over \(maxPixels / 1_000_000) MP) in a format that has to be decoded at full size")
        }
        return .downsample(maxPixelSize: min(longEdge, probe.longEdge))
    }

    /// Probe, decide and produce the model-sized JPEG. `.failure` carries the
    /// human-readable reason.
    static func prepare(url: URL, quality: CGFloat = 0.85) -> Result<Prepared, PrepareError> {
        guard let probe = probe(url: url) else { return .failure(.notAnImage) }
        switch decide(probe) {
        case .refuse(let reason):
            return .failure(.refused(reason))
        case .downsample(let maxPixelSize):
            let options = [kCGImageSourceShouldCache: false] as CFDictionary
            guard let source = CGImageSourceCreateWithURL(url as CFURL, options),
                  let image = thumbnail(source: source, maxPixelSize: maxPixelSize),
                  let jpeg = jpegData(image, quality: quality) else { return .failure(.notAnImage) }
            return .success(Prepared(probe: probe, jpegData: jpeg, width: image.width, height: image.height))
        }
    }

    enum PrepareError: Error, Equatable {
        case notAnImage
        case refused(String)
    }

    static func thumbnail(source: CGImageSource, maxPixelSize: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    static func jpegData(_ image: CGImage, quality: CGFloat) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}
