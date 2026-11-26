import { createFragmentRenderer } from "../fragment-preview";
import { readManifest, type CatalogEntry, type Manifest } from "../storage";
import { createOutline } from "./outline";
import { applyFontPreference } from "./preferences";
import {
  clickedLink,
  externalUrl,
  focusPosition,
  getDestination,
  isPlainClick,
  prepareReferences,
} from "./references";
import {
  parseReaderRoute,
  readerHash,
  readReturnTrail,
  type ReaderRoute,
  type ReturnPoint,
} from "./route";

interface ReaderControls {
  library: HTMLElement;
  panel: HTMLElement;
  heading: HTMLElement;
  contents: HTMLElement;
  outline: HTMLElement;
  outlinePanel: HTMLDetailsElement;
  fontSize: HTMLSelectElement;
  previous: HTMLButtonElement;
  next: HTMLButtonElement;
  returnToLibrary: HTMLButtonElement;
  returnToReference: HTMLButtonElement;
  status: HTMLElement;
}

interface BookNavigation {
  key: string;
  manifest: Manifest;
  order: string[];
  lookup: Map<string, { index: number; section: string }>;
}

interface DisplayedPosition {
  book: BookNavigation;
  fragment: string;
  index: number;
}

function buildNavigation(key: string, manifest: Manifest): BookNavigation {
  const order: string[] = [];
  const lookup: BookNavigation["lookup"] = new Map();
  for (const section of manifest.sections) {
    for (const fragment of section.fragmentIds) {
      lookup.set(fragment, { section: section.id, index: order.length });
      order.push(fragment);
    }
  }
  return { key, manifest, order, lookup };
}

export function startReader(controls: ReaderControls) {
  const renderer = createFragmentRenderer(controls.contents);
  const listeners = new AbortController();
  let book: BookNavigation | undefined;
  let displayed: DisplayedPosition | undefined;
  let request: AbortController | undefined;
  let trail: ReturnPoint[] = [];
  let focusBeforeReading: HTMLElement | undefined;
  let lastEntry: string | undefined;
  let rendering: Promise<void> = Promise.resolve();
  const outline = createOutline(
    controls.outline,
    controls.outlinePanel,
    goToFragment,
  );

  function disableNavigation() {
    controls.previous.disabled = true;
    controls.next.disabled = true;
    controls.returnToReference.hidden = trail.length === 0;
  }

  function resetReader() {
    displayed = undefined;
    book = undefined;
    trail = [];
    renderer.clear();
    outline.show([]);
    controls.panel.hidden = true;
    controls.library.hidden = false;
    controls.status.textContent = "";
    disableNavigation();
    focusBeforeReading?.focus();
    focusBeforeReading = undefined;
  }

  function showLoading(route: ReaderRoute) {
    if (book?.key !== route.book) {
      book = undefined;
      controls.heading.textContent = "Lecture";
      outline.show([]);
    }
    if (
      displayed?.book.key !== route.book ||
      displayed.fragment !== route.fragment
    ) {
      displayed = undefined;
      renderer.clear();
    }
    controls.library.hidden = true;
    controls.panel.hidden = false;
    controls.status.textContent = "Chargement…";
    disableNavigation();
  }

  async function loadBook(key: string, signal: AbortSignal) {
    if (book?.key === key) return book;
    const manifest = await readManifest(key, signal);
    signal.throwIfAborted();
    if (manifest?.schemaVersion !== 1) return undefined;
    book = buildNavigation(key, manifest);
    controls.heading.textContent = manifest.title;
    outline.show(manifest.sections);
    return book;
  }

  function showPosition(
    navigation: BookNavigation,
    route: ReaderRoute,
    fragment: string,
    position: { index: number; section: string },
  ) {
    displayed = { book: navigation, fragment, index: position.index };
    controls.previous.disabled = position.index === 0;
    controls.next.disabled = position.index === navigation.order.length - 1;
    outline.select(position.section);
    controls.status.textContent = focusPosition(
      controls.contents,
      controls.heading,
      route,
    )
      ? `Fragment ${position.index + 1} sur ${navigation.order.length}.`
      : "Renvoi indisponible dans ce fragment.";
  }

  async function render(
    route: ReaderRoute | undefined,
    nextTrail: ReturnPoint[],
  ) {
    request?.abort();
    if (!route) {
      resetReader();
      return;
    }
    const started = performance.now();
    const next = new AbortController();
    request = next;
    trail = nextTrail;
    showLoading(route);
    try {
      const navigation = await loadBook(route.book, next.signal);
      if (!navigation) {
        controls.status.textContent = "Ouvrage indisponible sur cet appareil.";
        controls.heading.focus();
        return;
      }
      next.signal.throwIfAborted();
      await loadFragment(navigation, route, started, next.signal);
    } catch {
      if (!next.signal.aborted) {
        controls.status.textContent =
          "Impossible d’ouvrir le contenu de cet ouvrage.";
        controls.heading.focus();
      }
    }
  }

  async function loadFragment(
    navigation: BookNavigation,
    route: ReaderRoute,
    started: number,
    signal: AbortSignal,
  ) {
    const fragment = route.fragment ?? navigation.order[0];
    const position = fragment ? navigation.lookup.get(fragment) : undefined;
    if (!fragment || !position) {
      controls.status.textContent = "Fragment indisponible sur cet appareil.";
      controls.heading.focus();
      return;
    }
    if (displayed?.fragment !== fragment) {
      const rendered = await renderer.open(
        navigation.key,
        fragment,
        (content) => {
          prepareReferences(
            content,
            navigation.key,
            navigation.manifest.destinations,
          );
        },
      );
      if (!rendered || signal.aborted) return;
      performance.measure("fragment-open", { start: started });
    }
    showPosition(navigation, route, fragment, position);
  }

  function synchronize() {
    const hash = location.hash;
    const route = parseReaderRoute(hash);
    const nextTrail = route ? readReturnTrail(history.state, route.book) : [];
    const entry = hash + JSON.stringify(nextTrail);
    if (entry !== lastEntry) {
      lastEntry = entry;
      rendering = render(route, nextTrail);
    }
    return rendering;
  }

  function navigate(route?: ReaderRoute, returnPoints: ReturnPoint[] = []) {
    const url = new URL(location.href);
    url.hash = route ? readerHash(route) : "";
    const state = route
      ? { blactureReturn: { book: route.book, points: returnPoints } }
      : null;
    history.pushState(state, "", url);
    return synchronize();
  }

  function open(entry: CatalogEntry) {
    if (document.activeElement instanceof HTMLElement)
      focusBeforeReading = document.activeElement;
    const route: ReaderRoute = { book: entry.key };
    if (entry.firstFragmentId) route.fragment = entry.firstFragmentId;
    return navigate(route);
  }

  function goToFragment(fragment: string) {
    if (book) void navigate({ book: book.key, fragment }, trail);
  }

  function step(offset: number) {
    if (!displayed) return;
    const fragment = displayed.book.order[displayed.index + offset];
    if (fragment) goToFragment(fragment);
  }

  function followReference(link: HTMLAnchorElement) {
    if (!displayed) return;
    const { book: navigation, fragment } = displayed;
    const target = getDestination(
      navigation.manifest.destinations,
      link.dataset.targetAnchor ?? "",
    );
    if (!target) {
      controls.status.textContent = "Renvoi indisponible.";
      return;
    }
    const previous = trail.at(-1);
    if (
      previous?.fragment === target.fragmentId &&
      (target.elementId === previous.anchor ||
        target.elementId === previous.authoredAnchor)
    ) {
      returnToPassage();
      return;
    }
    const point: ReturnPoint = { fragment, anchor: link.id };
    const authoredParent = link.parentElement?.closest(
      '[id^="blacture-anchor-"]',
    );
    if (authoredParent) point.authoredAnchor = authoredParent.id;
    const nextTrail = [...trail, point];
    void navigate(
      {
        book: navigation.key,
        fragment: target.fragmentId,
        anchor: target.elementId,
      },
      nextTrail,
    );
  }

  function returnToPassage() {
    const target = trail.at(-1);
    const route = parseReaderRoute(location.hash);
    if (target && route) {
      void navigate(
        { book: route.book, fragment: target.fragment, anchor: target.anchor },
        trail.slice(0, -1),
      );
    }
  }

  function activateExternal(link: HTMLAnchorElement) {
    const url = externalUrl(link);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  controls.contents.addEventListener(
    "click",
    (event) => {
      const link = clickedLink(event);
      if (!link || !isPlainClick(event)) return;
      event.preventDefault();
      if (link.dataset.targetAnchor !== undefined) followReference(link);
      else activateExternal(link);
    },
    { signal: listeners.signal },
  );
  controls.contents.addEventListener(
    "keydown",
    (event) => {
      const link = clickedLink(event);
      if (event.key === "Enter" && link?.dataset.externalUrl !== undefined) {
        event.preventDefault();
        activateExternal(link);
      }
    },
    { signal: listeners.signal },
  );
  controls.previous.addEventListener("click", () => step(-1), {
    signal: listeners.signal,
  });
  controls.next.addEventListener("click", () => step(1), {
    signal: listeners.signal,
  });
  controls.returnToLibrary.addEventListener(
    "click",
    () => {
      void navigate();
    },
    { signal: listeners.signal },
  );
  controls.returnToReference.addEventListener("click", returnToPassage, {
    signal: listeners.signal,
  });
  window.addEventListener(
    "popstate",
    () => {
      void synchronize();
    },
    { signal: listeners.signal },
  );
  window.addEventListener(
    "hashchange",
    () => {
      void synchronize();
    },
    { signal: listeners.signal },
  );
  controls.heading.tabIndex = -1;
  applyFontPreference(controls.fontSize, controls.contents, controls.status);
  void synchronize();

  return {
    open,
    dispose() {
      listeners.abort();
      request?.abort();
      renderer.clear();
    },
  };
}
