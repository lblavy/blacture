import type { Element, RootContent } from "hast";
import { sha256 } from "./identity";
import { readRaster } from "./raster";
import { elements, stringProperty } from "./tree";
import type { ImportedResource, ReportDiagnostic } from "./types";

export async function extractResources(
  nodes: RootContent[],
  report: ReportDiagnostic,
  signal: AbortSignal | undefined,
  originalUrl: (value: string) => string,
): Promise<ImportedResource[]> {
  const resources = new Map<string, ImportedResource>();
  for (const image of elements(nodes)) {
    if (image.tagName !== "img") continue;
    signal?.throwIfAborted();
    const resource = readRaster(originalUrl(stringProperty(image, "src")));
    delete image.properties.src;
    delete image.properties.dataSourceImage;
    if (!resource) {
      report("missing-resource", "error");
      preserveAltText(image);
      continue;
    }
    const id = await sha256(resource.bytes);
    if (!resources.has(id)) resources.set(id, { id, ...resource });
    image.properties.dataResourceId = id;
  }
  return [...resources.values()];
}

function preserveAltText(image: Element) {
  const { id, className } = image.properties;
  const alt = stringProperty(image, "alt");
  image.tagName = "span";
  image.properties = { id, className };
  image.children = [{ type: "text", value: alt }];
}
