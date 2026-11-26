import type { ReadingUnit } from "./domain/progress";

const block = "[data-block-id]";
const navigationLink = "a[data-target-anchor],a[href^='#']";
export const excludedReadingRegions = [
  "h1,h2,h3,h4,h5,h6",
  "nav,[role='navigation'],[role='doc-toc'],[data-toc]",
  "[role='doc-endnotes'],[role='doc-footnote'],[data-footnotes]",
  "[role='doc-noteref'],[role='doc-backlink'],[data-footnote-ref],[data-footnote-backref]",
].join(",");

function normalizeText(text: string) {
  return text.normalize().replace(/\s+/gu, " ").trim();
}

function isNavigation(element: Element) {
  const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = text.nextNode(); node; node = text.nextNode()) {
    if (
      normalizeText(node.textContent ?? "") &&
      !node.parentElement?.closest(navigationLink)
    )
      return false;
  }
  return true;
}

function weightOf(element: Element) {
  const text = normalizeText(element.textContent);
  if (text) return isNavigation(element) ? 0 : [...text].length;
  return element.matches("img") || element.querySelector("img") ? 80 : 0;
}

export function extractReadingUnits(
  html: string,
  expectedIds: readonly string[] = [],
): ReadingUnit[] {
  const template = document.createElement("template");
  // Parse the already sanitized fragment without attaching content or resolving image URLs.
  template.innerHTML = html;
  const found = new Set(
    [...template.content.querySelectorAll(block)].map((element) =>
      element.getAttribute("data-block-id"),
    ),
  );
  if (expectedIds.some((id) => !found.has(id)))
    throw new Error("Fragment incohérent.");
  for (const element of template.content.querySelectorAll(
    excludedReadingRegions,
  ))
    element.remove();

  const units: ReadingUnit[] = [];
  for (const element of template.content.querySelectorAll<HTMLElement>(block)) {
    const id = element.dataset.blockId;
    if (!id || element.parentElement?.closest(block)) continue;
    const weight = weightOf(element);
    if (weight > 0) units.push({ id, weight });
  }
  return units;
}
