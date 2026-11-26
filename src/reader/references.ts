import type { ImportDestination } from "../import";
import { readerHash, type ReaderRoute } from "./route";

export function getDestination(
  destinations: Record<string, ImportDestination>,
  name: string,
): ImportDestination | undefined {
  return Object.hasOwn(destinations, name) ? destinations[name] : undefined;
}

export function prepareReferences(
  fragment: DocumentFragment,
  book: string,
  destinations: Record<string, ImportDestination>,
) {
  let counter = 0;
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>(
    "a[data-target-anchor]",
  )) {
    const target = getDestination(
      destinations,
      link.dataset.targetAnchor ?? "",
    );
    if (!target) continue;
    link.href = readerHash({
      book,
      fragment: target.fragmentId,
      anchor: target.elementId,
    });
    if (!link.id) link.id = `blacture-reference-${++counter}`;
  }
  for (const link of fragment.querySelectorAll<HTMLAnchorElement>(
    "a[data-external-url]",
  )) {
    if (!externalUrl(link)) continue;
    link.setAttribute("role", "link");
    link.tabIndex = 0;
  }
}

export function externalUrl(link: HTMLAnchorElement): string | undefined {
  const raw = link.dataset.externalUrl;
  if (!raw || !/^(?:https?:\/\/|mailto:)/i.test(raw) || !URL.canParse(raw))
    return undefined;
  const url = new URL(raw);
  if (url.origin === location.origin || url.username || url.password)
    return undefined;
  return url.href;
}

export function clickedLink(event: Event): HTMLAnchorElement | null {
  return event.target instanceof Element
    ? event.target.closest("a[data-target-anchor], a[data-external-url]")
    : null;
}

export function isPlainClick(event: MouseEvent) {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

export function focusPosition(
  contents: HTMLElement,
  heading: HTMLElement,
  route: ReaderRoute,
): boolean {
  if (!route.anchor) {
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: "start" });
    return true;
  }
  const target = document.getElementById(route.anchor);
  if (!target || !contents.contains(target)) return false;
  for (
    let parent = target.parentElement?.closest("details");
    parent;
    parent = parent.parentElement?.closest("details")
  ) {
    parent.open = true;
  }
  // An anchor without href can report tabIndex 0 although focus() ignores it.
  if (!target.matches("[tabindex], a[href], summary")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "center" });
  return true;
}
