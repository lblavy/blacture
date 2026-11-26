import { afterEach, expect, it, vi } from "vitest";
import { readingCandidate, watchReading } from "../src/reader/reading-observer";

const viewport = { top: 100, bottom: 500, left: 0, right: 400 };
function box(id: string, top: number, bottom: number, left = 0, right = 400) {
  return { id, box: { top, bottom, left, right } };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("selects a single visible unit closest to the usable viewport center", () => {
  expect(
    readingCandidate(
      [
        box("obscured", 0, 110),
        box("margin", 435, 535),
        box("centered", 240, 360),
        box("clipped", 180, 420, 600, 1000),
      ],
      viewport,
    ),
  ).toEqual({ id: "centered", coverage: 15 });
  expect(readingCandidate([box("obscured", 0, 110)], viewport)).toBeUndefined();
});

it("requires a substantial visible area and does not credit a giant unit in one view", () => {
  const huge = [box("long", 0, 3200)];
  expect(readingCandidate(huge, viewport)).toEqual({ id: "long", coverage: 1 });
  expect(
    readingCandidate(huge, { ...viewport, top: 2450, bottom: 2850 }),
  ).toEqual({ id: "long", coverage: 8 });
  expect(readingCandidate([box("thin", 480, 2000)], viewport)).toBeUndefined();
  expect(readingCandidate([box("empty", 250, 250)], viewport)).toBeUndefined();
});

it("only accrues stable focused time and discards intervals spanning scroll or hidden tabs", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const toolbar = document.createElement("header");
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 400, 75),
  );
  const text = document.createElement("p");
  text.dataset.blockId = "eligible";
  vi.spyOn(text, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 350, 400, 100),
  );
  const contents = document.createElement("article");
  contents.append(text);
  const observations = vi.fn();
  const stop = watchReading(
    contents,
    toolbar,
    [{ id: "eligible", weight: 30 }],
    observations,
  );
  try {
    vi.advanceTimersByTime(3_000);
    expect(observations.mock.calls.map(([value]) => value.elapsedMs)).toEqual([
      0, 1000, 1000,
    ]);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(1_000);
    expect(observations).toHaveBeenLastCalledWith({
      id: "eligible",
      elapsedMs: 0,
      coverage: 15,
    });
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    const count = observations.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(observations).toHaveBeenCalledTimes(count);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2_000);
    expect(
      observations.mock.calls.slice(-2).map(([value]) => value.elapsedMs),
    ).toEqual([0, 1000]);
  } finally {
    stop();
  }
  const count = observations.mock.calls.length;
  vi.advanceTimersByTime(5_000);
  expect(observations).toHaveBeenCalledTimes(count);
});

it("does not credit masked text in a folded editorial detail", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const contents = document.createElement("article");
  contents.innerHTML =
    '<details data-block-id="fold"><summary>Résumé</summary><p>Texte masqué.</p></details>';
  const folded = contents.querySelector("details")!;
  vi.spyOn(folded, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 300, 400, 100),
  );
  const observations = vi.fn();
  const stop = watchReading(
    contents,
    document.createElement("header"),
    [{ id: "fold", weight: 30 }],
    observations,
  );
  try {
    vi.advanceTimersByTime(10_000);
    expect(observations).not.toHaveBeenCalled();
    folded.open = true;
    vi.advanceTimersByTime(2_000);
    expect(observations).toHaveBeenLastCalledWith({
      id: "fold",
      elapsedMs: 1000,
      coverage: 15,
    });
  } finally {
    stop();
  }
});

it("keeps visible prose eligible when a folded note is excluded from the index", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const contents = document.createElement("article");
  contents.innerHTML =
    '<div data-block-id="prose"><p>Le chemin est visible.</p><details role="doc-footnote"><summary>Note</summary><p>Commentaire.</p></details></div>';
  vi.spyOn(
    contents.firstElementChild!,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 300, 400, 100));
  const observations = vi.fn();
  const stop = watchReading(
    contents,
    document.createElement("header"),
    [{ id: "prose", weight: 22 }],
    observations,
  );
  try {
    vi.advanceTimersByTime(2_000);
    expect(observations).toHaveBeenLastCalledWith({
      id: "prose",
      elapsedMs: 1000,
      coverage: 15,
    });
  } finally {
    stop();
  }
});
