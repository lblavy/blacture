import { describe, expect, it } from "vitest";
import { migrateEditionProgress } from "../src/domain/edition-migration";
import {
  BOOK_SCOPE,
  EMPTY_PROGRESS,
  FULL_COVERAGE,
  READING_TIME_MS,
  type ReadingIndex,
} from "../src/domain/progress";
import { importMarkdown } from "../src/import";
import { extractReadingUnits } from "../src/reading-index";

const section = "section-00000000000001";
const child = "section-00000000000002";
const repeat = "section-00000000000003";
function unitId(digit: string) {
  return `${section}-block-${digit.repeat(14)}`;
}
const [alpha, beta, gamma, delta] = [
  unitId("1"),
  unitId("2"),
  unitId("3"),
  unitId("4"),
] as const;
const completed = { elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE };
const partial = { elapsedMs: 200, coverage: 0b1000 };

function blocks(...ids: string[]) {
  return ids.map((id) => ({ id, weight: 30 }));
}

function flat(fragments: ReadingIndex["fragments"]): ReadingIndex {
  return {
    sections: [
      { id: section, parentId: null, fragmentIds: Object.keys(fragments) },
    ],
    fragments,
  };
}

async function readingIndex(markdown: string): Promise<ReadingIndex> {
  const { sections, fragments } = await importMarkdown(markdown);
  return {
    sections,
    fragments: Object.fromEntries(
      fragments.map(({ id, html, blockIds }) => [
        id,
        extractReadingUnits(html, blockIds),
      ]),
    ),
  };
}

describe("edition progress migration", () => {
  it("recovers unchanged observations and follows a block across fragment boundaries", () => {
    const previous = flat({ original: blocks(alpha, beta, gamma) });
    const next = flat({
      before: blocks(delta),
      after: [...blocks(beta), { id: gamma, weight: 31 }],
    });
    expect(
      migrateEditionProgress(previous, next, {
        observations: {
          [alpha]: completed,
          [beta]: partial,
          [gamma]: completed,
        },
        modes: {},
        last: { fragmentId: "original", blockId: beta },
      }),
    ).toEqual({
      progress: {
        observations: { [beta]: partial },
        modes: {},
        last: { fragmentId: "after", blockId: beta },
      },
      omitted: 2,
    });
  });

  it("converts an expanded manual read scope without marking additions", () => {
    const previous = {
      sections: [
        { id: section, parentId: null, fragmentIds: ["parent"] },
        { id: child, parentId: section, fragmentIds: ["child"] },
      ],
      fragments: { parent: blocks(alpha), child: blocks(beta) },
    };
    const next = {
      ...previous,
      fragments: { ...previous.fragments, parent: blocks(delta, alpha) },
    };
    expect(
      migrateEditionProgress(previous, next, {
        observations: { [beta]: completed },
        modes: { [BOOK_SCOPE]: "read", [child]: "unread" },
      }),
    ).toEqual({
      progress: {
        observations: { [alpha]: completed, [beta]: completed },
        modes: { [child]: "unread" },
      },
      omitted: 1,
    });
  });

  it("does not reactivate observations masked by a changed unread scope", () => {
    const previous = flat({ original: blocks(alpha, beta) });
    const next = flat({ original: blocks(alpha) });
    expect(
      migrateEditionProgress(previous, next, {
        observations: { [alpha]: completed },
        modes: { [section]: "unread" },
      }),
    ).toEqual({ progress: EMPTY_PROGRESS, omitted: 2 });
  });

  it("rejects reused occurrence IDs for repeated blocks and headings", () => {
    const previous: ReadingIndex = {
      sections: [
        { id: section, parentId: null, fragmentIds: ["plain"] },
        { id: repeat, parentId: null, fragmentIds: ["first"] },
        { id: `${repeat}-2`, parentId: null, fragmentIds: ["second"] },
      ],
      fragments: {
        plain: blocks(alpha, `${alpha}-2`, beta),
        first: blocks(gamma),
        second: blocks(delta),
      },
    };
    const next: ReadingIndex = {
      sections: previous.sections.slice(0, 2),
      fragments: { plain: blocks(alpha, beta), first: blocks(delta, gamma) },
    };
    expect(
      migrateEditionProgress(previous, next, {
        observations: {
          [alpha]: completed,
          [beta]: partial,
          [gamma]: completed,
        },
        modes: { [repeat]: "read" },
        last: { fragmentId: "plain", blockId: alpha },
      }),
    ).toEqual({
      progress: { observations: { [beta]: partial }, modes: {} },
      omitted: 4,
    });
  });

  it("recovers the beginning of a fragment through its first reading block", () => {
    const previous = flat({ original: blocks(alpha, beta) });
    const next = flat({ original: blocks(delta, alpha, beta) });
    expect(
      migrateEditionProgress(previous, next, {
        ...EMPTY_PROGRESS,
        last: { fragmentId: "original" },
      }),
    ).toEqual({
      progress: {
        ...EMPTY_PROGRESS,
        last: { fragmentId: "original", blockId: alpha },
      },
      omitted: 0,
    });
  });

  it("retains manual book and section modes through a pure refragmentation", () => {
    const previous = flat({ original: blocks(alpha, beta) });
    const next = flat({ first: blocks(alpha), second: blocks(beta) });
    const progress = {
      ...EMPTY_PROGRESS,
      modes: { [BOOK_SCOPE]: "unread", [section]: "read" } as const,
    };
    expect(migrateEditionProgress(previous, next, progress)).toEqual({
      progress,
      omitted: 0,
    });
  });

  it("tracks stable passages across two Markdown imports and rejects a duplicated prelude", async () => {
    const previous = await readingIndex(
      "Même phrase.\n\nMême phrase.\n\n# Chapitre\n\nPassage conservé.\n\nPassage corrigé.",
    );
    const next = await readingIndex(
      "Même phrase.\n\n# Chapitre\n\nTexte ajouté.\n\nPassage conservé.\n\nCorrection publiée.",
    );
    const [prelude, chapter] = Object.values(previous.fragments);
    const repeated = prelude?.[0]?.id ?? "";
    const stable = chapter?.[0]?.id ?? "";
    const edited = chapter?.[1]?.id ?? "";
    expect(new Set([repeated, stable, edited]).size).toBe(3);
    expect(
      migrateEditionProgress(previous, next, {
        observations: {
          [repeated]: completed,
          [stable]: partial,
          [edited]: completed,
        },
        modes: {},
      }),
    ).toEqual({
      progress: { observations: { [stable]: partial }, modes: {} },
      omitted: 2,
    });
  });

  it("preserves a fragment start only when the former first block matches", () => {
    const previous = flat({ original: blocks(alpha, beta) });
    const next = flat({ split: blocks(alpha), later: blocks(beta) });
    expect(
      migrateEditionProgress(previous, next, {
        ...EMPTY_PROGRESS,
        last: { fragmentId: "original" },
      }).progress.last,
    ).toEqual({ fragmentId: "split" });
    expect(
      migrateEditionProgress(previous, next, {
        ...EMPTY_PROGRESS,
        last: { fragmentId: "absent", blockId: beta },
      }),
    ).toEqual({ progress: EMPTY_PROGRESS, omitted: 1 });
  });

  it("leaves a saved anchor in the backup when there is no matching reading block", () => {
    const edition = flat({ original: blocks(alpha) });
    expect(
      migrateEditionProgress(edition, edition, {
        ...EMPTY_PROGRESS,
        last: { fragmentId: "original", anchor: "footnote" },
      }),
    ).toEqual({ progress: EMPTY_PROGRESS, omitted: 1 });
  });

  it("projects each explicit correction once across a large collection of blocks", () => {
    const sectionCount = 2_000;
    const sections = Array.from({ length: sectionCount }, (_, number) => ({
      id: `chapter-${number}`,
      parentId: number === 0 ? null : `chapter-${number - 1}`,
      fragmentIds: [`fragment-${number}`],
    }));
    const index: ReadingIndex = {
      sections,
      fragments: Object.fromEntries(
        sections.map(({ id, fragmentIds }) => [
          fragmentIds[0],
          blocks(
            ...Array.from({ length: 4 }, (_, number) => `${id}/${number}`),
          ),
        ]),
      ),
    };
    let modeReads = 0;
    const result = migrateEditionProgress(index, index, {
      ...EMPTY_PROGRESS,
      modes: {
        get [BOOK_SCOPE]() {
          modeReads++;
          return "read" as const;
        },
      },
    });
    expect(result.progress.modes).toEqual({ [BOOK_SCOPE]: "read" });
    expect(result.omitted).toBe(0);
    expect(modeReads).toBe(1);
  });
});
