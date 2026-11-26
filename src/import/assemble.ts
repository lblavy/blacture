import type { Element, RootContent } from "hast";
import { toHtml } from "hast-util-to-html";
import { headingLevel, type AnchorIndex } from "./anchors";
import { fingerprint, UniqueIds } from "./identity";
import type { OutlineBlock } from "./outline";
import { elements, stringProperty, textContent } from "./tree";
import type {
  ImportedFragment,
  ImportedSection,
  ImportDestination,
} from "./types";

const fragmentTargetLength = 200_000;

interface SectionContent {
  section: ImportedSection;
  blocks: RootContent[];
}

export function assemble(outline: OutlineBlock[], anchors: AnchorIndex) {
  const incoming = groupSections(outline, anchors);
  const destinations = Object.create(null) as Record<string, ImportDestination>;
  const fragments: ImportedFragment[] = [];
  for (const { section, blocks } of incoming) {
    const sectionFragments = fragmentSection(
      section.id,
      blocks,
      anchors,
      destinations,
    );
    section.fragmentIds = sectionFragments.map((fragment) => fragment.id);
    for (const fragment of sectionFragments) fragments.push(fragment);
  }
  return {
    sections: incoming.map(({ section }) => section),
    fragments,
    destinations,
  };
}

function groupSections(
  outline: OutlineBlock[],
  anchors: AnchorIndex,
): SectionContent[] {
  const sections: SectionContent[] = [];
  const parents: ImportedSection[] = [];
  const ids = new UniqueIds();
  let current: SectionContent | undefined;
  for (const { node, heading } of outline) {
    if (heading) {
      current = createSection(
        heading,
        headingLevel(heading),
        parents,
        anchors,
        ids,
      );
      sections.push(current);
    } else if (!current) {
      current = {
        section: {
          id: "section-prelude",
          parentId: null,
          title: "Introduction",
          level: 0,
          fragmentIds: [],
        },
        blocks: [],
      };
      sections.push(current);
    }
    current.blocks.push(node);
  }
  return sections;
}

function createSection(
  heading: Element,
  level: number,
  parents: ImportedSection[],
  anchors: AnchorIndex,
  ids: UniqueIds,
): SectionContent {
  while (parents.length > 0 && (parents.at(-1)?.level ?? 0) >= level)
    parents.pop();
  const parentId = parents.at(-1)?.id ?? null;
  const title = textContent(heading).trim();
  const name = anchors.explicit.has(heading)
    ? `anchor\u0000${anchors.byElement.get(heading)}`
    : `${parentId ?? "root"}\u0000${title.normalize("NFC")}`;
  const section: ImportedSection = {
    id: ids.next(`section-${fingerprint(name)}`),
    level,
    parentId,
    title,
    fragmentIds: [],
  };
  parents.push(section);
  return { section, blocks: [] };
}

interface FragmentBuffer {
  html: string[];
  length: number;
  blockIds: string[];
  resourceIds: Set<string>;
  destinations: [string, string][];
}

function emptyBuffer(): FragmentBuffer {
  return {
    html: [],
    length: 0,
    blockIds: [],
    resourceIds: new Set(),
    destinations: [],
  };
}

function fragmentSection(
  sectionId: string,
  nodes: RootContent[],
  anchors: AnchorIndex,
  destinations: Record<string, ImportDestination>,
): ImportedFragment[] {
  const output: ImportedFragment[] = [];
  const ids = new UniqueIds();
  let buffer = emptyBuffer();
  for (const node of nodes) {
    const block = blockElement(node);
    const blockId = ids.next(
      `${sectionId}-block-${fingerprint(blockSignature(block, anchors))}`,
    );
    block.properties.dataBlockId = blockId;
    const html = toHtml(block);
    if (
      buffer.length > 0 &&
      buffer.length + html.length > fragmentTargetLength
    ) {
      output.push(
        finishFragment(buffer, sectionId, output.length, destinations),
      );
      buffer = emptyBuffer();
    }
    buffer.html.push(html);
    buffer.length += html.length;
    buffer.blockIds.push(blockId);
    collectReferences(block, buffer, anchors);
  }
  if (buffer.blockIds.length > 0)
    output.push(finishFragment(buffer, sectionId, output.length, destinations));
  return output;
}

function blockElement(node: RootContent): Element {
  if (node.type === "element") return node;
  return {
    type: "element",
    tagName: "span",
    properties: {},
    children: node.type === "text" ? [node] : [],
  };
}

function blockSignature(block: Element, anchors: AnchorIndex) {
  const tokens: string[] = [];
  appendSignature(block, tokens, anchors);
  return tokens.join("\u0000");
}

function appendSignature(
  node: RootContent,
  tokens: string[],
  anchors: AnchorIndex,
) {
  if (node.type === "text") tokens.push(`text:${node.value.normalize("NFC")}`);
  if (node.type !== "element") return;
  tokens.push(`open:${node.tagName}`);
  if (anchors.explicit.has(node))
    tokens.push(`anchor:${anchors.byElement.get(node)}`);
  if (node.tagName === "img") tokens.push(`alt:${stringProperty(node, "alt")}`);
  for (const key of ["dataResourceId", "dataTargetAnchor", "dataExternalUrl"]) {
    const value = stringProperty(node, key);
    if (value) tokens.push(`${key}:${value}`);
  }
  for (const child of node.children) appendSignature(child, tokens, anchors);
  tokens.push(`close:${node.tagName}`);
}

function collectReferences(
  block: Element,
  buffer: FragmentBuffer,
  anchors: AnchorIndex,
) {
  for (const element of elements([block])) {
    const resourceId = stringProperty(element, "dataResourceId");
    if (resourceId) buffer.resourceIds.add(resourceId);
    const anchor = anchors.byElement.get(element);
    if (anchor)
      buffer.destinations.push([anchor, stringProperty(element, "id")]);
  }
}

function finishFragment(
  buffer: FragmentBuffer,
  sectionId: string,
  index: number,
  destinations: Record<string, ImportDestination>,
): ImportedFragment {
  const id = `${sectionId}-fragment-${index + 1}`;
  for (const [name, elementId] of buffer.destinations)
    destinations[name] = { fragmentId: id, elementId };
  return {
    id,
    sectionId,
    html: buffer.html.join("\n"),
    blockIds: buffer.blockIds,
    resourceIds: [...buffer.resourceIds],
  };
}
