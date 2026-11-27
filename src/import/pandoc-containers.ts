import type { Parent, Paragraph, Root, RootContent, Text } from "mdast";
import type { ReportDiagnostic } from "./types";

interface PandocContainer extends Parent {
  type: "pandocContainer";
  children: RootContent[];
}

declare module "mdast" {
  interface RootContentMap {
    pandocContainer: PandocContainer;
  }
}

interface Marker {
  start: number;
  end: number;
  attributes: string | undefined;
  paired?: boolean;
}

const delimiter =
  /(?:^|\n)( {0,3}:{3,}[ \t]*(?:(\{[^\n]*?\}|[\p{L}\p{M}\p{N}_-]+)[ \t]*(?::{3,}[ \t]*)?)?)(?=\n|$)/gu;
const supportedAttributes =
  /^\{[ \t]*[.#][\p{L}\p{M}\p{N}_:-]+(?:[ \t]+[.#][\p{L}\p{M}\p{N}_:-]+)*[ \t]*\}$/u;
const literalTag =
  /^<(\/?)(code|pre|script|style|textarea|xmp|plaintext|iframe|noembed|noframes|noscript|svg|math)(?=[\s/>])/i;
const maxContainerDepth = 32;
const maxAttributeLength = 256;

export function pandocContainers(source: string, report: ReportDiagnostic) {
  return (tree: Root) => {
    const markers = collectMarkers(tree, source);
    pairMarkers(markers, report);
    if (markers.size > 0) wrapContainers(tree, markers);
  };
}

function collectMarkers(tree: Root, source: string) {
  const markers = new Map<Text, Marker[]>();
  for (const block of tree.children) {
    if (block.type !== "paragraph") continue;
    collectParagraphMarkers(block, source, markers);
  }
  return markers;
}

function collectParagraphMarkers(
  block: Paragraph,
  source: string,
  markers: Map<Text, Marker[]>,
) {
  let literal: string | undefined;
  for (const child of block.children) {
    if (child.type === "html") {
      literal = literalContext(child.value, literal);
    } else if (
      !literal &&
      child.type === "text" &&
      child.value.includes(":::")
    ) {
      const delimiters = textMarkers(child, source);
      if (delimiters.length > 0) markers.set(child, delimiters);
    }
  }
}

function literalContext(html: string, current: string | undefined) {
  const tag = literalTag.exec(html);
  if (!tag) return current;
  const name = tag[2]!.toLowerCase();
  if (tag[1] === "/") return name === current ? undefined : current;
  return current ?? name;
}

function textMarkers(node: Text, source: string): Marker[] {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  const raw = findDelimiters(source.slice(start, end));
  const decoded = findDelimiters(node.value);
  // Escapes and character references can produce apparent delimiters in text.
  // Match raw and decoded markers before splicing the decoded text by position.
  if (raw.length !== decoded.length) return [];
  return decoded.filter((marker, index) => {
    const original = raw[index]!;
    return (
      marker.attributes === original.attributes &&
      isPhysicalLine(source, start + original.start, start + original.end)
    );
  });
}

function findDelimiters(value: string): Marker[] {
  return Array.from(value.matchAll(delimiter), (match) => {
    const end = match.index + match[0].length;
    return { start: end - match[1]!.length, end, attributes: match[2] };
  });
}

function isPhysicalLine(source: string, start: number, end: number) {
  const prefix = source.slice(Math.max(0, start - 4), start);
  return (
    /(?:^|\n) {0,3}$/.test(prefix) &&
    (end === source.length || source[end] === "\n")
  );
}

function pairMarkers(markers: Map<Text, Marker[]>, report: ReportDiagnostic) {
  const openings: Marker[] = [];
  for (const marker of Array.from(markers.values()).flat()) {
    if (marker.attributes !== undefined) {
      openings.push(marker);
      continue;
    }
    const opener = openings.pop();
    if (!opener || openings.length >= maxContainerDepth) {
      report("unmatched-container-marker", "warning");
      if (opener) report("unmatched-container-marker", "warning");
      continue;
    }
    const attributes = opener.attributes!;
    if (
      attributes.length > maxAttributeLength ||
      !supportedAttributes.test(attributes)
    ) {
      report("unsupported-container-marker", "warning");
      continue;
    }
    opener.paired = marker.paired = true;
  }
  openings.forEach(() => report("unmatched-container-marker", "warning"));
  for (const [text, candidates] of markers) {
    const paired = candidates.filter((marker) => marker.paired);
    if (paired.length > 0) markers.set(text, paired);
    else markers.delete(text);
  }
}

function wrapContainers(tree: Root, markers: Map<Text, Marker[]>) {
  const result: RootContent[] = [];
  const parents = [result];
  function switchContainer(marker: Marker) {
    if (marker.attributes === undefined) {
      parents.pop();
      return;
    }
    const children: RootContent[] = [];
    const { id, classes } = readAttributes(marker.attributes);
    parents.at(-1)!.push({
      type: "pandocContainer",
      data: { hProperties: { id, className: classes } },
      children,
    });
    parents.push(children);
  }
  for (const block of tree.children) {
    if (
      block.type === "paragraph" &&
      block.children.some(
        (child) => child.type === "text" && markers.has(child),
      )
    ) {
      splitParagraph(block, markers, switchContainer, (part) =>
        parents.at(-1)!.push(part),
      );
    } else {
      parents.at(-1)!.push(block);
    }
  }
  tree.children = result;
}

function readAttributes(attributes: string) {
  const tokens = attributes
    .slice(1, -1)
    .trim()
    .split(/[ \t]+/);
  return {
    id: tokens
      .filter((token) => token.startsWith("#"))
      .at(-1)
      ?.slice(1),
    classes: tokens
      .filter((token) => token.startsWith("."))
      .map((token) => token.slice(1)),
  };
}

function splitParagraph(
  block: Paragraph,
  markers: Map<Text, Marker[]>,
  switchContainer: (marker: Marker) => void,
  append: (part: Paragraph) => void,
) {
  let children: Paragraph["children"] = [];
  for (const child of block.children) {
    const delimiters = child.type === "text" ? markers.get(child) : undefined;
    if (child.type !== "text" || !delimiters) {
      children.push(child);
      continue;
    }
    let start = 0;
    for (const marker of delimiters) {
      addText(
        children,
        child.value.slice(start, marker.start).replace(/\n$/, ""),
      );
      if (children.length > 0) append({ type: "paragraph", children });
      children = [];
      switchContainer(marker);
      start = marker.end;
      if (child.value[start] === "\n") start++;
    }
    addText(children, child.value.slice(start));
  }
  if (children.length > 0) append({ ...block, children });
}

function addText(children: Paragraph["children"], value: string) {
  if (value) children.push({ type: "text", value });
}
