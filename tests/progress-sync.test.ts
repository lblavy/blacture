import { describe, expect, it } from "vitest";
import {
  BOOK_SCOPE,
  EMPTY_PROGRESS,
  FULL_COVERAGE,
  READING_TIME_MS,
  effectiveMode,
  summarizeProgress,
  type ReadingIndex,
} from "../src/domain/progress";
import {
  mergeProgressEvents,
  type ProgressEvent,
} from "../src/domain/progress-sync";

const index: ReadingIndex = {
  sections: [
    { id: "part", parentId: null, fragmentIds: [] },
    { id: "section-30", parentId: "part", fragmentIds: ["fragment-30"] },
    { id: "section-35", parentId: "part", fragmentIds: ["fragment-35"] },
  ],
  fragments: {
    "fragment-30": [{ id: "passage-30", weight: 1 }],
    "fragment-35": [{ id: "passage-35", weight: 1 }],
  },
};

function observe(
  deviceId: string,
  clock: number,
  unitId: string,
  elapsedMs = READING_TIME_MS,
  coverage = FULL_COVERAGE,
): ProgressEvent {
  return {
    deviceId,
    clock,
    kind: "observe",
    samples: [{ unitId, elapsedMs, coverage }],
  };
}

describe("projection du journal de lecture B06", () => {
  it("conserve les deux passages acquis hors ligne dans chaque ordre d’arrivée", () => {
    const windows = observe("windows", 1, "passage-30");
    const android = observe("android", 1, "passage-35");
    const left = mergeProgressEvents(index, [windows, android]);
    const right = mergeProgressEvents(index, [android, windows]);
    expect(left).toEqual(right);
    expect(summarizeProgress(index, left).book).toMatchObject({
      status: "complete",
      readWeight: 2,
    });
  });

  it("rejoint le temps et la couverture des observations distinctes sans les recompter", () => {
    const windows = observe("windows", 2, "passage-30", 4_000, 0b0011);
    const retry: ProgressEvent = {
      samples: [{ coverage: 0b0011, unitId: "passage-30", elapsedMs: 4_000 }],
      kind: "observe",
      clock: 2,
      deviceId: "windows",
    };
    const android = observe("android", 6, "passage-30", 5_000, 0b1100);
    expect(mergeProgressEvents(index, [windows, retry]).observations).toEqual({
      "passage-30": { elapsedMs: 4_000, coverage: 0b0011 },
    });
    expect(
      mergeProgressEvents(index, [retry, android, windows, android])
        .observations,
    ).toEqual({
      "passage-30": { elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
    });
  });

  it("conserve le sens de réinitialisation parent/enfant et retrouve les observations en automatique", () => {
    const book: ProgressEvent = {
      kind: "mode",
      deviceId: "windows",
      clock: 2,
      scopeId: BOOK_SCOPE,
      mode: "read",
    };
    const child: ProgressEvent = {
      kind: "mode",
      deviceId: "android",
      clock: 3,
      scopeId: "section-35",
      mode: "unread",
    };
    const reset: ProgressEvent = {
      kind: "mode",
      deviceId: "windows",
      clock: 4,
      scopeId: "part",
      mode: "auto",
    };
    const sample = observe("android", 1, "passage-30");
    const beforeReset = mergeProgressEvents(index, [child, sample, book]);
    expect(effectiveMode(index, beforeReset, "section-35")).toBe("unread");
    const afterReset = mergeProgressEvents(index, [reset, child, sample, book]);
    expect(afterReset.modes).toEqual({ [BOOK_SCOPE]: "read", part: "auto" });
    expect(summarizeProgress(index, afterReset).firstUnread).toEqual({
      fragmentId: "fragment-35",
      blockId: "passage-35",
    });
  });

  it("départage des corrections concurrentes par identifiant ordinal", () => {
    const first: ProgressEvent = {
      kind: "mode",
      deviceId: "Z",
      clock: 1,
      scopeId: BOOK_SCOPE,
      mode: "read",
    };
    const second: ProgressEvent = {
      kind: "mode",
      deviceId: "a",
      clock: 1,
      scopeId: BOOK_SCOPE,
      mode: "unread",
    };
    expect(mergeProgressEvents(index, [second, first, second]).modes).toEqual({
      [BOOK_SCOPE]: "unread",
    });
  });

  it("mémorise une visite au chapitre 30 sans effacer l’acquis au chapitre 35", () => {
    const earlier: ProgressEvent = {
      kind: "visit",
      deviceId: "android",
      clock: 3,
      position: { fragmentId: "fragment-35", blockId: "passage-35" },
    };
    const later: ProgressEvent = {
      kind: "visit",
      deviceId: "windows",
      clock: 4,
      position: {
        fragmentId: "fragment-30",
        blockId: "passage-30",
        anchor: "note",
      },
    };
    const retry: ProgressEvent = {
      ...later,
      position: {
        anchor: "note",
        blockId: "passage-30",
        fragmentId: "fragment-30",
      },
    };
    const state = mergeProgressEvents(index, [
      later,
      observe("android", 1, "passage-35"),
      earlier,
      retry,
    ]);
    expect(state.last).toEqual(later.position);
    expect(state.observations).toEqual({
      "passage-35": { elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
    });
  });

  it("signale des charges différentes pour la même identité dans les deux ordres", () => {
    const first = observe("windows", 1, "passage-30");
    const second = observe("windows", 1, "passage-35");
    const malformedRetry: ProgressEvent = {
      kind: "visit",
      deviceId: "windows",
      clock: 1,
      position: { fragmentId: "fragment-30" },
    };
    for (const events of [
      [first, second],
      [second, first],
      [first, malformedRetry],
    ])
      expect(() => mergeProgressEvents(index, events)).toThrow(/identité/u);
  });

  it("rend l’état vide pour un journal vide et signale une horloge invalide", () => {
    expect(mergeProgressEvents(index, [])).toEqual(EMPTY_PROGRESS);
    for (const invalid of [NaN, 0, -1, 1.5, Infinity])
      expect(() =>
        mergeProgressEvents(index, [observe("a", invalid, "passage-30")]),
      ).toThrow(/horloge/u);
    expect(() =>
      mergeProgressEvents(index, [observe("", 1, "passage-30")]),
    ).toThrow(/appareil/u);
  });
});
