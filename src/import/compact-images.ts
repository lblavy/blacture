import type { Element, Root } from "hast";
import { walk } from "./tree";

const largeImageUrl =
  /data:(image\/(?:png|jpeg|webp));base64,[A-Za-z0-9+/=]{2048,}/gi;

interface CompactedImages {
  source: string;
  restoreEditorialText(tree: Root): void;
  imageUrl(value: string): string;
}

// Keep very long payloads out of both parsers while retaining the original URL grammar.
// The same pattern can occur in text and code; restore those occurrences before sanitizing.
export function compactImages(input: string): CompactedImages {
  const payloads = new Map<string, string>();
  const prefix = `blacture${crypto.randomUUID().replaceAll("-", "")}x`;
  const source = input.replace(largeImageUrl, (url: string, mime: string) => {
    const marker = `data:${mime.toLowerCase()};base64,${prefix}${payloads.size}z`;
    payloads.set(marker, url);
    return marker;
  });
  const markerPattern = new RegExp(
    `data:image/(?:png|jpeg|webp);base64,${prefix}\\d+z`,
    "g",
  );
  const imageUrl = (marker: string) => payloads.get(marker) ?? marker;
  const restore = (value: string) =>
    value.includes(prefix) ? value.replace(markerPattern, imageUrl) : value;
  return {
    source,
    imageUrl,
    restoreEditorialText(tree) {
      if (payloads.size === 0) return;
      for (const node of walk(tree.children)) {
        if (node.type === "text") node.value = restore(node.value);
        if (node.type === "element") restoreProperties(node, restore);
      }
    },
  };
}

function restoreProperties(
  element: Element,
  restore: (value: string) => string,
) {
  for (const [key, value] of Object.entries(element.properties)) {
    if (element.tagName === "img" && key === "src") continue;
    if (typeof value === "string") element.properties[key] = restore(value);
    if (Array.isArray(value)) {
      element.properties[key] = value.map((part) =>
        typeof part === "string" ? restore(part) : part,
      );
    }
  }
}
