import type { Element, Root, RootContent } from "hast";

export function* elements(nodes: RootContent[]): Generator<Element> {
  for (const node of walk(nodes)) if (node.type === "element") yield node;
}

export function* walk(nodes: RootContent[]): Generator<RootContent> {
  const stack = [nodes[Symbol.iterator]()];
  for (let iterator = stack.at(-1); iterator; iterator = stack.at(-1)) {
    const next = iterator.next();
    if (next.done) {
      stack.pop();
    } else {
      const node = next.value;
      yield node;
      if (node.type === "element") stack.push(node.children[Symbol.iterator]());
    }
  }
}

export function textContent(node: RootContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  if (node.tagName === "img") return stringProperty(node, "alt");
  return node.children.map(textContent).join("");
}

export function stringProperty(element: Element, key: string): string {
  const value = element.properties[key];
  return typeof value === "string" ? value : "";
}

export function visibleNodes(tree: Root): RootContent[] {
  return tree.children.filter(
    (node) =>
      node.type === "element" ||
      (node.type === "text" && node.value.trim() !== ""),
  );
}
