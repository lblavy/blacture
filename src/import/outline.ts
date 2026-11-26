import type { Element, ElementContent, RootContent } from "hast";
import { headingLevel } from "./anchors";

export interface OutlineBlock<Node extends RootContent = RootContent> {
  node: Node;
  heading: Element | null;
}

const sectionContainers = new Set(["article", "div", "section"]);

export function outlineBlocks<Node extends RootContent>(
  nodes: Node[],
): OutlineBlock<Node | Element>[] {
  return nodes.flatMap(outlineBlock);
}

function outlineBlock<Node extends RootContent>(
  node: Node,
): OutlineBlock<Node | Element>[] {
  if (node.type !== "element") return [{ node, heading: null }];
  if (headingLevel(node)) return [{ node, heading: node }];
  if (
    !sectionContainers.has(node.tagName) ||
    Object.hasOwn(node.properties, "dataFootnotes")
  ) {
    return [{ node, heading: null }];
  }
  const children = outlineBlocks(node.children);
  if (!children.some(({ heading }) => heading !== null))
    return [{ node, heading: null }];
  return splitContainer(node, children);
}

function splitContainer(
  container: Element,
  blocks: OutlineBlock<ElementContent>[],
): OutlineBlock<Element>[] {
  const result: OutlineBlock<Element>[] = [];
  let heading: Element | null = null;
  let children: ElementContent[] = [];
  function flush() {
    if (children.some(isVisible)) {
      const properties = { ...container.properties };
      if (result.length > 0) delete properties.id;
      result.push({ node: { ...container, properties, children }, heading });
    }
    children = [];
  }
  for (const block of blocks) {
    if (block.heading) {
      flush();
      heading = block.heading;
    }
    children.push(block.node);
  }
  flush();
  return result;
}

function isVisible(node: RootContent) {
  return (
    node.type === "element" ||
    (node.type === "text" && node.value.trim() !== "")
  );
}
