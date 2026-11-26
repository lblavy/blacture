import type { Element, RootContent } from "hast";
import { fingerprint, UniqueIds } from "./identity";
import { elements, stringProperty, textContent } from "./tree";
import type { ReportDiagnostic } from "./types";

export interface AnchorIndex {
  readonly byName: Map<string, string>;
  readonly byElement: WeakMap<Element, string>;
  readonly explicit: WeakSet<Element>;
}

export function headingLevel(node: RootContent): number {
  if (node.type !== "element" || !/^h[1-6]$/.test(node.tagName)) return 0;
  return Number(node.tagName[1]);
}

export function indexAnchors(
  nodes: RootContent[],
  headings: Element[],
  report: ReportDiagnostic,
): AnchorIndex {
  const byName = new Map<string, string>();
  const byElement = new WeakMap<Element, string>();
  const ids = new UniqueIds();
  const headingNames = new UniqueIds();
  const index = { byName, byElement, explicit: new WeakSet<Element>() };
  for (const element of elements(nodes))
    assignExplicitId(element, index, ids, report);
  for (const heading of headings) {
    if (!byElement.has(heading)) {
      const slug = headingSlug(textContent(heading));
      const name = unusedHeadingName(slug, byName, headingNames);
      assignId(heading, name, index, ids);
    }
  }
  return index;
}

function assignExplicitId(
  element: Element,
  index: AnchorIndex,
  ids: UniqueIds,
  report: ReportDiagnostic,
) {
  const name = stringProperty(element, "id").normalize("NFC");
  if (!name) {
    delete element.properties.id;
    return;
  }
  if (index.byName.has(name)) {
    report("duplicate-anchor", "error");
    delete element.properties.id;
    return;
  }
  assignId(element, name, index, ids);
  index.explicit.add(element);
}

function assignId(
  element: Element,
  name: string,
  index: AnchorIndex,
  ids: UniqueIds,
) {
  const id = ids.next(`blacture-anchor-${fingerprint(name)}`);
  element.properties.id = id;
  index.byName.set(name, id);
  index.byElement.set(element, name);
}

function headingSlug(title: string) {
  return (
    title
      .normalize("NFC")
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]+/gu, "")
      .replace(/\s+/g, "-") || "section"
  );
}

function unusedHeadingName(
  slug: string,
  used: Map<string, string>,
  names: UniqueIds,
) {
  let name = names.next(slug);
  while (used.has(name)) name = names.next(slug);
  return name;
}

export function rewriteReferences(
  nodes: RootContent[],
  index: AnchorIndex,
  report: ReportDiagnostic,
) {
  for (const element of elements(nodes)) {
    if (element.tagName === "a") rewriteLink(element, index, report);
    rewriteAriaIdReferences(element, index);
  }
}

function rewriteLink(
  element: Element,
  index: AnchorIndex,
  report: ReportDiagnostic,
) {
  const href = stringProperty(element, "href").trim();
  delete element.properties.href;
  if (!href) return;
  if (href.startsWith("#")) {
    const target = resolveAnchor(href.slice(1), index.byName);
    if (target) element.properties.dataTargetAnchor = target;
    else report("unresolved-anchor", "error");
  } else {
    const url = safeExternalUrl(href);
    if (url) element.properties.dataExternalUrl = url;
    else report("unsupported-link", "warning");
  }
}

function resolveAnchor(
  fragment: string,
  names: Map<string, string>,
): string | undefined {
  try {
    const decoded = decodeURIComponent(fragment).normalize("NFC");
    if (names.has(decoded)) return decoded;
  } catch {
    // An anchor can include a literal percent sign.
  }
  const literal = fragment.normalize("NFC");
  return names.has(literal) ? literal : undefined;
}

function safeExternalUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (
    ["https:", "http:", "mailto:"].includes(url.protocol) &&
    !url.username &&
    !url.password
  )
    return url.href;
  return undefined;
}

function rewriteAriaIdReferences(element: Element, index: AnchorIndex) {
  for (const key of ["ariaDescribedBy", "ariaLabelledBy"]) {
    const previous = element.properties[key];
    if (!Array.isArray(previous)) continue;
    const ids = previous.flatMap(
      (name) => index.byName.get(String(name).normalize("NFC")) ?? [],
    );
    if (ids.length > 0) element.properties[key] = ids;
    else delete element.properties[key];
  }
}
