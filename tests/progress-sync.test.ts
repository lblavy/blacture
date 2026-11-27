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
) {
  return {
    deviceId,
    clock,
    kind: "observe" as const,
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

  it("fusionne par maximum les lectures reprises, puis cumule les nouvelles observations", () => {
    const windows = {
      ...observe("windows", 2, "passage-30", 4_000, 0b0011),
      kind: "migrate" as const,
    };
    const android = {
      ...observe("android", 5, "passage-30", 5_000, 0b1100),
      kind: "migrate" as const,
    };
    const other = {
      ...observe("android", 6, "passage-35"),
      kind: "migrate" as const,
    };
    const newReading = observe("windows", 3, "passage-30", 2_000, 0b0100);
    const events = [newReading, windows, android, other, windows, newReading];
    expect(mergeProgressEvents(index, [windows, android]).observations).toEqual(
      {
        "passage-30": { elapsedMs: 5_000, coverage: FULL_COVERAGE },
      },
    );
    const merged = mergeProgressEvents(index, events);
    expect(merged).toEqual(mergeProgressEvents(index, [...events].reverse()));
    expect(merged.observations).toEqual({
      "passage-30": { elapsedMs: 7_000, coverage: FULL_COVERAGE },
      "passage-35": { elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
    });
    expect(summarizeProgress(index, merged).firstUnread?.blockId).toBe(
      "passage-30",
    );
  });

  it("refuse un rejeu qui change la provenance des observations", () => {
    const sample = observe("windows", 1, "passage-30");
    const migrated = { ...sample, kind: "migrate" as const };
    for (const events of [
      [migrated, sample],
      [sample, migrated],
    ])
      expect(() => mergeProgressEvents(index, events)).toThrow(/identité/u);
  });

  it("donne la priorité aux corrections et positions de la nouvelle édition", () => {
    const correction = {
      kind: "mode" as const,
      deviceId: "windows",
      clock: 2,
      scopeId: "section-30",
      mode: "unread" as const,
    };
    const position = {
      kind: "visit" as const,
      deviceId: "windows",
      clock: 4,
      position: { fragmentId: "fragment-35", blockId: "passage-35" },
    };
    const inherited = [
      {
        ...correction,
        deviceId: "android",
        clock: 90,
        inherited: true as const,
        mode: "read" as const,
      },
      {
        ...position,
        deviceId: "android",
        clock: 91,
        inherited: true as const,
        position: { fragmentId: "fragment-30", blockId: "passage-30" },
      },
    ];
    const result = mergeProgressEvents(index, [
      position,
      ...inherited,
      correction,
    ]);
    expect(result.modes).toEqual({ "section-30": "unread" });
    expect(result.last).toEqual(position.position);
    for (const event of [correction, position])
      expect(() =>
        mergeProgressEvents(index, [
          { ...event, inherited: true as const },
          event,
        ]),
      ).toThrow(/identité/u);
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

  it("fusionne les corrections héritées par niveau sans effacer les chapitres", () => {
    const parent: ProgressEvent = {
      kind: "mode",
      deviceId: "windows",
      clock: 1,
      scopeId: "part",
      mode: "read",
      inherited: true,
    };
    const child: ProgressEvent = {
      ...parent,
      clock: 2,
      scopeId: "section-35",
      mode: "unread",
    };
    const anotherParent = { ...parent, deviceId: "android", clock: 3 };
    const journal = [child, anotherParent, parent, child];
    const joined = mergeProgressEvents(index, journal);
    expect(joined).toEqual(mergeProgressEvents(index, [...journal].reverse()));
    expect(joined.modes).toEqual({ part: "read", "section-35": "unread" });
    expect(effectiveMode(index, joined, "section-35")).toBe("unread");

    const reset: ProgressEvent = {
      kind: "mode",
      deviceId: parent.deviceId,
      clock: parent.clock,
      scopeId: parent.scopeId,
      mode: "auto",
    };
    expect(
      mergeProgressEvents(index, [reset, child, anotherParent]).modes,
    ).toEqual({
      part: "auto",
    });
  });

  it("départage les corrections héritées concurrentes sur un même niveau", () => {
    const book: ProgressEvent = {
      kind: "mode",
      deviceId: "android",
      clock: 1,
      scopeId: BOOK_SCOPE,
      mode: "read",
      inherited: true,
    };
    const override = { ...book, deviceId: "windows", mode: "unread" as const };
    const absent = { ...book, scopeId: "absent", clock: 2 };
    for (const journal of [
      [book, override, absent],
      [override, absent, book],
    ])
      expect(mergeProgressEvents(index, journal).modes).toEqual({
        [BOOK_SCOPE]: "unread",
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
