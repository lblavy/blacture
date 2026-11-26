export interface ReaderRoute {
  book: string;
  fragment?: string;
  anchor?: string;
}

export interface ReturnPoint {
  fragment: string;
  anchor: string;
  authoredAnchor?: string;
}

const routePrefix = "#lecture?";

export function parseReaderRoute(hash: string): ReaderRoute | undefined {
  if (!hash.startsWith(routePrefix)) return undefined;
  const parameters = new URLSearchParams(hash.slice(routePrefix.length));
  const book = parameters.get("book");
  if (!book) return undefined;
  const route: ReaderRoute = { book };
  const fragment = parameters.get("fragment");
  const anchor = parameters.get("anchor");
  if (fragment) route.fragment = fragment;
  if (anchor) route.anchor = anchor;
  return route;
}

export function readerHash(route: ReaderRoute): string {
  const parameters = new URLSearchParams({ book: route.book });
  if (route.fragment) parameters.set("fragment", route.fragment);
  if (route.anchor) parameters.set("anchor", route.anchor);
  return routePrefix + parameters.toString();
}

export function readReturnTrail(state: unknown, book: string): ReturnPoint[] {
  if (!state || typeof state !== "object" || !("blactureReturn" in state))
    return [];
  const value = state.blactureReturn;
  if (
    !value ||
    typeof value !== "object" ||
    !("book" in value) ||
    value.book !== book
  )
    return [];
  return "points" in value && Array.isArray(value.points)
    ? value.points.filter(isReturnPoint)
    : [];
}

function isReturnPoint(value: unknown): value is ReturnPoint {
  return (
    !!value &&
    typeof value === "object" &&
    "fragment" in value &&
    typeof value.fragment === "string" &&
    "anchor" in value &&
    typeof value.anchor === "string" &&
    (!("authoredAnchor" in value) || typeof value.authoredAnchor === "string")
  );
}
