// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { BOOK_SCOPE, type ReadingIndex } from "../src/domain/progress";
import type { ProgressEvent } from "../src/domain/progress-sync";
import type { ImportedFragment } from "../src/import";
import { validateDriveProgressReferences } from "../src/sync/progress-references";

const index: ReadingIndex = {
  sections: [{ id: "chapter", parentId: null, fragmentIds: ["f1", "f2"] }],
  fragments: { f1: [{ id: "b1", weight: 16 }], f2: [{ id: "b2", weight: 2 }] },
};
const manifest = {
  destinations: {
    note: { fragmentId: "f1", elementId: "blacture-anchor-note" },
  },
};
const fragment: ImportedFragment = {
  id: "f1",
  sectionId: "chapter",
  html: '<p><a data-target-anchor="note">Lire la note</a><a data-target-anchor="inconnu">Renvoi manquant</a></p>',
  blockIds: ["b1", "non-reader-block"],
  resourceIds: [],
};

const identity = { deviceId: "appareil", clock: 1 };

describe("références des événements Drive", () => {
  it("valide les événements ordinaires à partir de l’index et des ancres du manifeste", async () => {
    const readFragment = vi.fn();
    const events = [
      {
        ...identity,
        kind: "observe",
        samples: [{ unitId: "b1", elapsedMs: 10, coverage: 1 }],
      },
      {
        ...identity,
        kind: "migrate",
        samples: [{ unitId: "b2", elapsedMs: 10, coverage: 1 }],
      },
      { ...identity, kind: "mode", scopeId: BOOK_SCOPE, mode: "read" },
      { ...identity, kind: "mode", scopeId: "chapter", mode: "unread" },
      {
        ...identity,
        kind: "visit",
        position: {
          fragmentId: "f1",
          blockId: "b1",
          anchor: "blacture-anchor-note",
        },
      },
    ] satisfies ProgressEvent[];
    await expect(
      validateDriveProgressReferences(events, index, manifest, readFragment),
    ).resolves.toBeUndefined();
    expect(readFragment).not.toHaveBeenCalled();
  });

  it("lit un seul fragment si une visite pointe vers un renvoi sans identifiant ou un bloc hors index", async () => {
    const readFragment = vi.fn().mockResolvedValue(fragment);
    const position = {
      fragmentId: "f1",
      anchor: "blacture-reference-1",
      blockId: "non-reader-block",
    };
    const event = { ...identity, kind: "visit" as const, position };
    await expect(
      validateDriveProgressReferences(
        [event, event],
        index,
        manifest,
        readFragment,
      ),
    ).resolves.toBeUndefined();
    expect(readFragment).toHaveBeenCalledExactlyOnceWith("f1");
  });

  it.each([
    {
      ...identity,
      kind: "observe",
      samples: [{ unitId: "absent", elapsedMs: 10, coverage: 1 }],
    },
    {
      ...identity,
      kind: "migrate",
      samples: [{ unitId: "absent", elapsedMs: 10, coverage: 1 }],
    },
    { ...identity, kind: "mode", scopeId: "absent", mode: "read" },
    { ...identity, kind: "visit", position: { fragmentId: "absent" } },
    {
      ...identity,
      kind: "visit",
      position: { fragmentId: "f2", blockId: "b1" },
    },
    {
      ...identity,
      kind: "visit",
      position: { fragmentId: "f1", blockId: "absent" },
    },
    {
      ...identity,
      kind: "visit",
      position: { fragmentId: "f2", anchor: "blacture-anchor-note" },
    },
    {
      ...identity,
      kind: "visit",
      position: { fragmentId: "f1", anchor: "blacture-reference-2" },
    },
  ] satisfies ProgressEvent[])(
    "rejette une référence inconnue ou hors du fragment (%#)",
    async (event) => {
      await expect(
        validateDriveProgressReferences(
          [event],
          index,
          manifest,
          async () => fragment,
        ),
      ).rejects.toThrow(/référence/u);
    },
  );

  it("rejette un renvoi généré quand le fragment stocké est indisponible", async () => {
    const event = {
      ...identity,
      kind: "visit" as const,
      position: { fragmentId: "f1", anchor: "blacture-reference-1" },
    };
    await expect(
      validateDriveProgressReferences(
        [event],
        index,
        manifest,
        async () => undefined,
      ),
    ).rejects.toThrow(/référence/u);
  });
});
