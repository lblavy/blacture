import { describe, expect, it } from "vitest";
import {
  BOOK_SCOPE,
  COMPLETION_RATIO,
  EMPTY_PROGRESS,
  FULL_COVERAGE,
  READING_TIME_MS,
  changeMode,
  effectiveMode,
  isUnitComplete,
  observeReading,
  observeReadings,
  setLastConsultation,
  summarizeProgress,
  type ProgressState,
  type ReadingIndex,
} from "../src/domain/progress";

const basic: ReadingIndex = {
  sections: [
    { id: "parent", parentId: null, fragmentIds: ["preface"] },
    { id: "child", parentId: "parent", fragmentIds: ["chapter"] },
    { id: "grandchild", parentId: "child", fragmentIds: ["junior"] },
    { id: "blank", parentId: null, fragmentIds: ["navigation"] },
  ],
  fragments: {
    preface: [
      { id: "main", weight: 95 },
      { id: "end", weight: 5 },
    ],
    chapter: [{ id: "detail", weight: 200 }],
    junior: [{ id: "passage", weight: 300 }],
    navigation: [{ id: "toc", weight: 0 }],
  },
};

function complete(index: ReadingIndex, state: ProgressState, unitId: string) {
  return observeReading(index, state, unitId, READING_TIME_MS, FULL_COVERAGE);
}

describe("observations de lecture", () => {
  it("cumule huit secondes et exige le passage dans les quatre bandes d’un bloc long", () => {
    const first = observeReading(
      basic,
      EMPTY_PROGRESS,
      "main",
      READING_TIME_MS - 1,
      0b0011,
    );
    const crossed = observeReading(basic, first, "main", 1, 0b0100);
    const completeUnit = observeReading(basic, crossed, "main", 15, 0b1000);
    expect(isUnitComplete(first.observations.main)).toBe(false);
    expect(crossed.observations.main).toEqual({
      elapsedMs: READING_TIME_MS,
      coverage: 0b0111,
    });
    expect(isUnitComplete(crossed.observations.main)).toBe(false);
    expect(completeUnit.observations.main).toEqual({
      elapsedMs: READING_TIME_MS,
      coverage: FULL_COVERAGE,
    });
    expect(isUnitComplete(completeUnit.observations.main)).toBe(true);
    expect(
      observeReading(basic, completeUnit, "main", 500, FULL_COVERAGE),
    ).toBe(completeUnit);
  });

  it("n’avance pas au bout d’un balayage bref même si toutes les bandes sont visibles", () => {
    const sawEverything = observeReading(
      basic,
      EMPTY_PROGRESS,
      "main",
      350,
      FULL_COVERAGE,
    );
    expect(isUnitComplete(sawEverything.observations.main)).toBe(false);
    expect(
      summarizeProgress(basic, sawEverything).sections.parent,
    ).toMatchObject({ status: "partial", ownReadWeight: 0, percent: 0 });
  });

  it("traite un lot de mesures indépendantes par bloc et ignore les mesures absentes ou invalides", () => {
    const state = observeReadings(basic, EMPTY_PROGRESS, [
      { unitId: "main", elapsedMs: 4_000, coverage: 0b0011 },
      { unitId: "main", elapsedMs: 4_000, coverage: 0b11100 },
      { unitId: "detail", elapsedMs: 125, coverage: 0b0001 },
      { unitId: "end", elapsedMs: -5, coverage: FULL_COVERAGE },
      { unitId: "end", elapsedMs: Number.NaN, coverage: FULL_COVERAGE },
      { unitId: "end", elapsedMs: 500, coverage: -1 },
      { unitId: "end", elapsedMs: 500, coverage: 0 },
      { unitId: "toc", elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
      {
        unitId: "constructor",
        elapsedMs: READING_TIME_MS,
        coverage: FULL_COVERAGE,
      },
    ]);
    expect(state.observations).toEqual({
      main: { elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
      detail: { elapsedMs: 125, coverage: 1 },
    });
    expect(observeReadings(basic, state, [])).toBe(state);
    expect(EMPTY_PROGRESS.observations).toEqual({});
  });
});

describe("agrégation du contenu propre et des descendants", () => {
  it("applique le seuil de 95 % au contenu propre sans masquer les descendants encore à lire", () => {
    expect(COMPLETION_RATIO).toBe(0.95);
    const ownComplete = complete(basic, EMPTY_PROGRESS, "main");
    const summary = summarizeProgress(basic, ownComplete);
    expect(summary.sections.parent).toEqual({
      status: "partial",
      percent: 15,
      ownWeight: 100,
      ownReadWeight: 95,
      totalWeight: 600,
      readWeight: 95,
    });
    expect(summary.firstUnread).toEqual({
      fragmentId: "chapter",
      blockId: "detail",
    });
    const descendantsComplete = changeMode(basic, ownComplete, "child", "read");
    const resulting = summarizeProgress(basic, descendantsComplete);
    expect(resulting.book).toMatchObject({
      status: "complete",
      percent: 100,
      readWeight: 595,
    });
    expect(resulting.sections.parent?.status).toBe("complete");
    expect(resulting.sections.blank).toMatchObject({
      status: "empty",
      totalWeight: 0,
      percent: 0,
    });
    expect(resulting.firstUnread).toBeUndefined();
  });

  it("ne valide pas un parent dont le corps propre est à 94 %, même si ses enfants sont lus", () => {
    const index: ReadingIndex = {
      ...basic,
      fragments: {
        ...basic.fragments,
        preface: [
          { id: "main", weight: 94 },
          { id: "end", weight: 6 },
        ],
      },
    };
    const partialOwn = complete(index, EMPTY_PROGRESS, "main");
    const state = changeMode(index, partialOwn, "child", "read");
    const summary = summarizeProgress(index, state);
    expect(summary.book.status).toBe("partial");
    expect(summary.sections.parent).toMatchObject({
      status: "partial",
      ownReadWeight: 94,
      ownWeight: 100,
      readWeight: 594,
    });
    expect(summary.firstUnread).toEqual({
      fragmentId: "preface",
      blockId: "end",
    });
  });

  it("distingue navigation, section sans corps et vrai livre vide", () => {
    const index: ReadingIndex = {
      sections: [
        { id: "heading", parentId: null, fragmentIds: [] },
        { id: "guide", parentId: "heading", fragmentIds: ["map"] },
      ],
      fragments: { map: [{ id: "outline", weight: 0 }] },
    };
    const state = setLastConsultation(index, EMPTY_PROGRESS, {
      fragmentId: "map",
      anchor: "sommaire",
    });
    const forced = changeMode(index, state, BOOK_SCOPE, "read");
    expect(forced.last).toEqual({ fragmentId: "map", anchor: "sommaire" });
    expect(summarizeProgress(index, forced)).toMatchObject({
      book: { status: "empty", percent: 0 },
      sections: { heading: { status: "empty" }, guide: { status: "empty" } },
    });
    expect(summarizeProgress(index, forced).firstUnread).toBeUndefined();
  });
});

describe("modes manuels et reprises", () => {
  it("garde les mesures brutes en mode non lu et autorise une exception auto d’un enfant", () => {
    let state = changeMode(basic, EMPTY_PROGRESS, "parent", "unread");
    state = complete(basic, state, "main");
    state = complete(basic, state, "detail");
    expect(summarizeProgress(basic, state).sections.parent?.status).toBe(
      "unstarted",
    );
    expect(summarizeProgress(basic, state).firstUnread).toEqual({
      fragmentId: "preface",
      blockId: "main",
    });
    const exception = changeMode(basic, state, "child", "auto");
    expect(effectiveMode(basic, state, "grandchild")).toBe("unread");
    expect(effectiveMode(basic, exception, "grandchild")).toBe("auto");
    const summary = summarizeProgress(basic, exception);
    expect(exception.observations).toBe(state.observations);
    expect(summary.sections.child?.ownReadWeight).toBe(200);
    expect(summary.sections.grandchild?.status).toBe("unstarted");
    expect(summary.sections.parent?.status).toBe("partial");
    const resumedAuto = changeMode(basic, exception, "parent", "auto");
    expect(summarizeProgress(basic, resumedAuto).firstUnread).toEqual({
      fragmentId: "junior",
      blockId: "passage",
    });
  });

  it("applique la correction d’un parent à son sous-arbre et laisse les exceptions extérieures", () => {
    let state = changeMode(basic, EMPTY_PROGRESS, BOOK_SCOPE, "read");
    expect(effectiveMode(basic, state, "grandchild")).toBe("read");
    state = changeMode(basic, state, "grandchild", "unread");
    state = changeMode(basic, state, "blank", "auto");
    expect(summarizeProgress(basic, state).firstUnread).toEqual({
      fragmentId: "junior",
      blockId: "passage",
    });
    state = changeMode(basic, state, "child", "read");
    expect(state.modes).toEqual({
      [BOOK_SCOPE]: "read",
      child: "read",
      blank: "auto",
    });
    expect(summarizeProgress(basic, state).book.status).toBe("complete");
    expect(changeMode(basic, state, "unknown", "read")).toBe(state);
    const reset = changeMode(basic, state, BOOK_SCOPE, "auto");
    expect(reset.modes).toEqual({ [BOOK_SCOPE]: "auto" });
    expect(summarizeProgress(basic, reset).book.status).toBe("unstarted");
  });

  it("retrouve le chapitre 7 et reprend au premier bloc restant du chapitre 30", () => {
    const sections = Array.from({ length: 32 }, (_, index) => ({
      id: `chapter-${index + 1}`,
      parentId: null,
      fragmentIds: [`fragment-${index + 1}`],
    }));
    const index: ReadingIndex = {
      sections,
      fragments: Object.fromEntries(
        sections.map(({ id, fragmentIds }) => [
          fragmentIds[0],
          [
            { id: `${id}-start`, weight: 10 },
            { id: `${id}-tail`, weight: 10 },
          ],
        ]),
      ),
    };
    let state = EMPTY_PROGRESS;
    for (const section of sections.slice(0, 29))
      state = changeMode(index, state, section.id, "read");
    state = complete(index, state, "chapter-30-start");
    state = setLastConsultation(index, state, {
      fragmentId: "fragment-7",
      blockId: "chapter-7-tail",
      anchor: "note-7",
    });
    expect(state.last).toEqual({
      fragmentId: "fragment-7",
      blockId: "chapter-7-tail",
      anchor: "note-7",
    });
    const summary = summarizeProgress(index, state);
    expect(summary.sections["chapter-7"]?.status).toBe("complete");
    expect(summary.sections["chapter-30"]?.status).toBe("partial");
    expect(summary.firstUnread).toEqual({
      fragmentId: "fragment-30",
      blockId: "chapter-30-tail",
    });
  });

  it("ignore les observations et modes d’une ancienne édition et dégrade une position obsolète au fragment", () => {
    const stale: ProgressState = {
      observations: {
        "removed-unit": { elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
      },
      modes: { "removed-section": "read" },
      last: { fragmentId: "removed-fragment" },
    };
    expect(summarizeProgress(basic, stale).book.status).toBe("unstarted");
    expect(
      setLastConsultation(basic, stale, { fragmentId: "removed-fragment" }),
    ).toBe(stale);
    const updated = setLastConsultation(basic, stale, {
      fragmentId: "chapter",
      blockId: "main",
    });
    expect(updated.last).toEqual({ fragmentId: "chapter" });
    expect(updated.modes).toBe(stale.modes);
    expect(updated.observations).toBe(stale.observations);
    expect(setLastConsultation(basic, updated, { fragmentId: "chapter" })).toBe(
      updated,
    );
  });

  it("compte un identifiant dupliqué au plus une fois et traite les clés propres sans hériter du prototype", () => {
    const index: ReadingIndex = {
      sections: [
        {
          id: "__proto__",
          parentId: null,
          fragmentIds: ["constructor", "duplicate"],
        },
      ],
      fragments: {
        constructor: [{ id: "__proto__", weight: 5 }],
        duplicate: [
          { id: "__proto__", weight: 12 },
          { id: "favicon", weight: Number.NaN },
        ],
      },
    };
    const initial = complete(index, EMPTY_PROGRESS, "__proto__");
    expect(Object.hasOwn(initial.observations, "__proto__")).toBe(true);
    const state = changeMode(index, initial, "__proto__", "unread");
    const summary = summarizeProgress(index, state);
    expect(Object.hasOwn(summary.sections, "__proto__")).toBe(true);
    expect(summary.book).toMatchObject({ status: "unstarted", totalWeight: 5 });
    expect(summary.firstUnread).toEqual({
      fragmentId: "constructor",
      blockId: "__proto__",
    });
  });
});
