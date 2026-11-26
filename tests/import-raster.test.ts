// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readRaster } from "../src/import/raster";

function rasterUri(mimeType: string, bytes: Uint8Array) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

// Minimal containers exercise boundaries and dimensions before the browser image decoder is involved.
function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(58);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x89504e47);
  header.setUint32(4, 0x0d0a1a0a);
  header.setUint32(8, 13);
  header.setUint32(12, 0x49484452);
  header.setUint32(16, width);
  header.setUint32(20, height);
  header.setUint32(33, 1);
  header.setUint32(37, 0x49444154); // IDAT with one byte
  header.setUint32(50, 0x49454e44); // IEND
  return bytes;
}

function webpHeader(chunk: "VP8 " | "VP8L" | "VP8X" | "RIFF") {
  const bytes = new Uint8Array(chunk === "VP8X" ? 48 : 30);
  const header = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"));
  header.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode(`WEBP${chunk}`), 8);
  header.setUint32(16, 10, true);
  if (chunk === "VP8L") bytes[20] = 0x2f;
  if (chunk === "VP8X") {
    bytes.set(new TextEncoder().encode("VP8L"), 30);
    header.setUint32(34, 10, true);
    bytes[38] = 0x2f;
  }
  if (chunk === "VP8 ") {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    header.setUint16(26, 1, true);
    header.setUint16(28, 1, true);
  }
  return bytes;
}

describe("embedded raster validation", () => {
  it("rejects metadata-only PNG and WebP containers", () => {
    expect(
      readRaster(rasterUri("image/png", pngHeader(10, 10).slice(0, 33))),
    ).toBeUndefined();
    const metadata = webpHeader("VP8X").slice(0, 30);
    new DataView(metadata.buffer).setUint32(4, 22, true);
    expect(readRaster(rasterUri("image/webp", metadata))).toBeUndefined();
  });

  it("rejects malformed PNG data and end boundaries", () => {
    const complete = pngHeader(10, 10);
    expect(
      readRaster(rasterUri("image/png", complete.slice(0, -1))),
    ).toBeUndefined();
    for (const offset of [33, 46, 50]) {
      const bytes = complete.slice();
      bytes[offset] = 0xff;
      expect(readRaster(rasterUri("image/png", bytes))).toBeUndefined();
    }
  });
  it("recognizes PNG headers and keeps decoded bytes", () => {
    const bytes = pngHeader(12, 2);
    expect(readRaster(rasterUri("IMAGE/PNG", bytes))).toEqual({
      mimeType: "image/png",
      bytes,
    });
  });

  it.each([
    [0, 12],
    [12, 0],
    [16_385, 1],
    [1, 16_385],
    [10_000, 10_000],
  ])("rejects disallowed PNG dimensions %i×%i", (width, height) =>
    expect(
      readRaster(rasterUri("image/png", pngHeader(width, height))),
    ).toBeUndefined(),
  );

  it.each([0, 4, 8, 12])(
    "rejects an invalid PNG header field at %i",
    (index) => {
      const bytes = pngHeader(10, 10);
      bytes[index] = bytes[index]! ^ 0xff;
      expect(readRaster(rasterUri("image/png", bytes))).toBeUndefined();
    },
  );

  it("rejects malformed base64, unexpected schemes and a truncated PNG header", () => {
    expect(readRaster("data:image/png;base64,%%%%")).toBeUndefined();
    expect(readRaster("data:image/svg+xml;base64,AAAA")).toBeUndefined();
    expect(
      readRaster(rasterUri("image/png", pngHeader(1, 1).slice(0, 30))),
    ).toBeUndefined();
  });

  it("rejects encoded and decoded data beyond the resource size limit", () => {
    const encodedLimit = Math.ceil((16 * 1024 * 1024) / 3) * 4;
    const overDecodedLimit = "A".repeat(encodedLimit);
    expect(
      readRaster(`data:image/png;base64,${overDecodedLimit}`),
    ).toBeUndefined();
    expect(
      readRaster(`data:image/png;base64,${overDecodedLimit}AAAA`),
    ).toBeUndefined();
  });

  it("finds a JPEG frame after a separate segment and a fill byte", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 1,
      0xff, 0xda, 0, 6, 0, 0, 0, 0, 0x01, 0xff, 0xd9,
    ]);
    expect(readRaster(rasterUri("image/jpeg", bytes))).toEqual({
      mimeType: "image/jpeg",
      bytes,
    });
  });

  it.each(
    [
      [0xff, 0xd8],
      [0xff, 0xe8, 0xff, 0xe0, 0, 2],
      [0xff, 0xd8, 0, 0xe0, 0, 2],
      [0xff, 0xd8, 0xff, 0xe0, 0, 1],
      [0xff, 0xd8, 0xff, 0xe0, 0, 12],
      [0xff, 0xd8, 0xff, 0xc0, 0, 2],
      [0xff, 0xd8, 1, 0xe0, 0, 2, 0xff, 0xd9],
      [0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff, 0xd9],
      [0xff, 0xd8, 0xff, 0xe0, 0, 12, 0xff, 0xd9],
      [0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 0xff, 0xd9],
    ].map((bytes) => ({ bytes })),
  )("rejects an incomplete JPEG $bytes", ({ bytes }) => {
    expect(
      readRaster(rasterUri("image/jpeg", new Uint8Array(bytes))),
    ).toBeUndefined();
  });

  it.each(["VP8 ", "VP8L", "VP8X"] as const)(
    "recognizes the WebP header %s",
    (chunk) => {
      const bytes = webpHeader(chunk);
      expect(readRaster(rasterUri("image/webp", bytes))).toEqual({
        mimeType: "image/webp",
        bytes,
      });
    },
  );

  it.each([0, 4, 8, 20, 23, 25])(
    "rejects a corrupted WebP header at %i",
    (index) => {
      const bytes = webpHeader(index === 20 ? "VP8L" : "VP8 ");
      bytes[index] = 0xff;
      expect(readRaster(rasterUri("image/webp", bytes))).toBeUndefined();
    },
  );

  it("rejects truncated WebP files and unsupported chunks", () => {
    expect(
      readRaster(rasterUri("image/webp", webpHeader("VP8X").slice(0, 20))),
    ).toBeUndefined();
    const truncated = webpHeader("VP8X").slice(0, 25);
    new DataView(truncated.buffer).setUint32(4, 17, true);
    expect(readRaster(rasterUri("image/webp", truncated))).toBeUndefined();
    expect(
      readRaster(rasterUri("image/webp", webpHeader("RIFF"))),
    ).toBeUndefined();
  });
});
