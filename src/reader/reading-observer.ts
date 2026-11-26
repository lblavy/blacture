import type { ReadingUnit } from "../domain/progress";
import { excludedReadingRegions } from "../reading-index";

interface Bounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Target {
  id: string;
  box: Bounds;
}

interface Candidate {
  id: string;
  coverage: number;
}

export interface ReadingSample extends Candidate {
  elapsedMs: number;
}

const sampleInterval = 1000;
const bandCount = 4;
const fullCoverage = (1 << bandCount) - 1;

function visibleBands(box: Bounds, top: number, bottom: number) {
  const height = box.bottom - box.top;
  const slice = height / bandCount;
  let coverage = 0;
  for (let band = 0; band < bandCount; band++) {
    const midpoint = box.top + (band + 0.5) * slice;
    if (top <= midpoint && midpoint <= bottom) coverage |= 1 << band;
  }
  const centralBand = Math.floor(((top + bottom) / 2 - box.top) / slice);
  return coverage || 1 << centralBand;
}

function visibleTarget({ box }: Target, viewport: Bounds) {
  const top = Math.max(box.top, viewport.top);
  const bottom = Math.min(box.bottom, viewport.bottom);
  const height = box.bottom - box.top;
  const width = box.right - box.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const viewportWidth = viewport.right - viewport.left;
  const visibleWidth =
    Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left);
  if (height <= 0 || width <= 0 || viewportHeight <= 0 || viewportWidth <= 0)
    return;
  if (bottom - top < Math.min(height, viewportHeight) / 2) return;
  if (visibleWidth < Math.min(width, viewportWidth) / 2) return;
  return {
    distance: Math.abs(
      (top + bottom) / 2 - (viewport.top + viewport.bottom) / 2,
    ),
    coverage:
      height <= viewportHeight ? fullCoverage : visibleBands(box, top, bottom),
  };
}

export function readingCandidate(
  targets: Iterable<Target>,
  viewport: Bounds,
): Candidate | undefined {
  let chosen: Candidate | undefined;
  let nearest = Infinity;
  for (const target of targets) {
    const visible = visibleTarget(target, viewport);
    if (visible && visible.distance < nearest) {
      nearest = visible.distance;
      chosen = { id: target.id, coverage: visible.coverage };
    }
  }
  return chosen;
}

interface ObservedElement {
  element: HTMLElement;
  disclosures: HTMLDetailsElement[];
}

function* measuredTargets(elements: Map<string, ObservedElement>) {
  for (const [id, { element, disclosures }] of elements) {
    if (disclosures.every(({ open }) => open))
      yield { id, box: element.getBoundingClientRect() };
  }
}

export function watchReading(
  contents: HTMLElement,
  toolbar: HTMLElement,
  units: readonly ReadingUnit[],
  onSample: (sample: ReadingSample) => void,
) {
  const relevant = new Set(units.map(({ id }) => id));
  const elements = new Map<string, ObservedElement>();
  for (const node of contents.querySelectorAll<HTMLElement>(
    "[data-block-id]",
  )) {
    const id = node.dataset.blockId!;
    if (relevant.has(id)) {
      const disclosures = Array.from(node.querySelectorAll("details")).filter(
        (detail) => !detail.closest(excludedReadingRegions),
      );
      if (node instanceof HTMLDetailsElement) disclosures.unshift(node);
      elements.set(id, { element: node, disclosures });
    }
  }
  const listeners = new AbortController();
  let previous: (Candidate & { time: number }) | undefined;

  function reset() {
    previous = undefined;
  }

  function sample() {
    if (document.visibilityState !== "visible" || !document.hasFocus()) {
      reset();
      return;
    }
    const viewport = {
      top: Math.max(0, toolbar.getBoundingClientRect().bottom),
      bottom: window.innerHeight,
      left: 0,
      right: window.innerWidth,
    };
    const chosen = readingCandidate(measuredTargets(elements), viewport);
    if (!chosen) {
      reset();
      return;
    }
    const time = performance.now();
    const stable =
      previous?.id === chosen.id && previous.coverage === chosen.coverage;
    const gap = stable ? time - previous!.time : 0;
    const elapsedMs =
      gap <= sampleInterval * 1.5 ? Math.min(gap, sampleInterval) : 0;
    previous = { ...chosen, time };
    onSample({ ...chosen, elapsedMs });
  }

  for (const event of [
    "scroll",
    "resize",
    "blur",
    "focus",
    "pagehide",
    "pageshow",
  ]) {
    window.addEventListener(event, reset, {
      signal: listeners.signal,
      passive: true,
    });
  }
  document.addEventListener("visibilitychange", reset, {
    signal: listeners.signal,
  });
  contents.addEventListener("toggle", reset, {
    signal: listeners.signal,
    capture: true,
  });
  const timer = window.setInterval(sample, sampleInterval);
  return () => {
    listeners.abort();
    window.clearInterval(timer);
  };
}
