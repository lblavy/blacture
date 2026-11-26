const maxImageBytes = 16 * 1024 * 1024;
const maxPixels = 25_000_000;
type RasterMime = "image/png" | "image/jpeg" | "image/webp";

export function readRaster(
  url: string,
): { mimeType: string; bytes: Uint8Array<ArrayBuffer> } | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,/i.exec(url);
  if (match?.[1] === undefined) return;
  const mimeType = match[1].toLowerCase() as RasterMime;
  const encoded = url.slice(match[0].length);
  if (encoded.length > Math.ceil(maxImageBytes / 3) * 4) return;
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return;
  }
  if (binary.length > maxImageBytes) return;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  if (!hasReasonableDimensions(mimeType, bytes)) return;
  return { mimeType, bytes };
}

function hasReasonableDimensions(
  mimeType: RasterMime,
  bytes: Uint8Array<ArrayBuffer>,
): boolean {
  const view = new DataView(bytes.buffer);
  const dimensions = readers[mimeType](view);
  if (!dimensions) return false;
  const [width, height] = dimensions;
  return (
    width > 0 &&
    height > 0 &&
    width <= 16_384 &&
    height <= 16_384 &&
    width * height <= maxPixels
  );
}

type Dimensions = readonly [number, number];

const readers: Record<
  RasterMime,
  (header: DataView) => Dimensions | undefined
> = {
  "image/png": pngDimensions,
  "image/jpeg": jpegDimensions,
  "image/webp": webpDimensions,
};

function pngDimensions(header: DataView): Dimensions | undefined {
  if (header.byteLength < 33) return;
  if (header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a)
    return;
  if (header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452) return; // IHDR
  if (!hasPngImageData(header)) return;
  return [header.getUint32(16), header.getUint32(20)];
}

function hasPngImageData(header: DataView): boolean {
  let hasData = false;
  for (let offset = 33; offset + 12 <= header.byteLength;) {
    const length = header.getUint32(offset);
    const type = header.getUint32(offset + 4);
    const end = offset + 12 + length;
    if (end > header.byteLength) return false;
    if (type === 0x49444154 && length > 0) hasData = true; // IDAT
    if (type === 0x49454e44)
      return hasData && length === 0 && end === header.byteLength; // IEND
    offset = end;
  }
  return false;
}

function jpegDimensions(header: DataView): Dimensions | undefined {
  if (!hasJpegBoundaries(header)) return;
  return findJpegScanDimensions(header);
}

function hasJpegBoundaries(header: DataView) {
  return (
    header.byteLength >= 4 &&
    header.getUint16(0) === 0xffd8 &&
    header.getUint16(header.byteLength - 2) === 0xffd9
  );
}

function findJpegScanDimensions(header: DataView): Dimensions | undefined {
  let dimensions: Dimensions | undefined;
  for (let index = 2; index + 3 < header.byteLength;) {
    if (header.getUint8(index) !== 0xff) return;
    const marker = header.getUint8(index + 1);
    if (marker === 0xff) {
      index += 1;
      continue;
    }
    const length = header.getUint16(index + 2);
    const end = index + 2 + length;
    if (length < 2 || end >= header.byteLength - 2) return;
    if (jpegFrameMarkers.has(marker) && length >= 8) {
      dimensions = [header.getUint16(index + 7), header.getUint16(index + 5)];
    }
    if (marker === 0xda) return length >= 6 ? dimensions : undefined; // SOS
    index = end;
  }
  return undefined;
}

const jpegFrameMarkers = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function webpDimensions(header: DataView): Dimensions | undefined {
  if (
    header.byteLength < 25 ||
    header.getUint32(0) !== 0x52494646 ||
    header.getUint32(8) !== 0x57454250
  )
    return;
  if (header.getUint32(4, true) + 8 !== header.byteLength) return;
  return findWebpFrame(header);
}

function findWebpFrame(header: DataView): Dimensions | undefined {
  let frame: Dimensions | undefined;
  let canvas: Dimensions | undefined;
  let offset = 12;
  for (; offset + 8 <= header.byteLength;) {
    const type = header.getUint32(offset);
    const length = header.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length + (length % 2);
    if (end > header.byteLength) return;
    if (type === 0x56503858 && length === 10) {
      // VP8X
      canvas = [
        1 + (header.getUint32(start + 3, true) >>> 8),
        1 + (header.getUint32(start + 6, true) >>> 8),
      ];
    }
    frame ??= webpChunkDimensions(header, type, start, length);
    offset = end;
  }
  return frame && offset === header.byteLength ? (canvas ?? frame) : undefined;
}

function webpChunkDimensions(
  header: DataView,
  type: number,
  start: number,
  length: number,
): Dimensions | undefined {
  if (type === 0x5650384c && length >= 5 && header.getUint8(start) === 0x2f) {
    // VP8L
    const bits = header.getUint32(start + 1, true);
    return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
  }
  if (
    type === 0x56503820 &&
    length >= 10 &&
    header.getUint16(start + 3) === 0x9d01 &&
    header.getUint8(start + 5) === 0x2a
  ) {
    return [
      header.getUint16(start + 6, true) & 0x3fff,
      header.getUint16(start + 8, true) & 0x3fff,
    ];
  }
  return undefined;
}
