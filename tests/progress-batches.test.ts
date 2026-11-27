// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ReadingIndex } from "../src/domain/progress";
import {
  fingerprintProgressIndex,
  projectProgressBatches,
} from "../src/sync/progress-batches";

const index: ReadingIndex = {
  sections: [{ id: "premier", parentId: null, fragmentIds: ["fragment"] }],
  fragments: { fragment: [{ id: "passage", weight: 100 }] },
};
const indexFingerprint = await fingerprintProgressIndex(index);
const edition = '["livre","edition"]';
const event = {
  deviceId: "appareil-a",
  clock: 1,
  kind: "observe",
  samples: [{ unitId: "passage", elapsedMs: 2_000, coverage: 3 }],
};

function batch(events: unknown = [event], overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    editionKey: edition,
    indexFingerprint,
    deviceId: event.deviceId,
    events,
    ...overrides,
  });
}

describe("lots de progression sérialisés", () => {
  it("projette des événements valides sans compter deux fois un lot rejoué", async () => {
    const inputs = [
      batch(),
      batch([
        {
          ...event,
          clock: 2,
          kind: "visit",
          position: { fragmentId: "fragment", blockId: "passage", anchor: "a" },
        },
        { ...event, clock: 3, kind: "mode", scopeId: "premier", mode: "read" },
      ]),
      batch(),
    ];
    expect(await projectProgressBatches(index, edition, inputs)).toEqual({
      observations: { passage: { elapsedMs: 2_000, coverage: 3 } },
      modes: { premier: "read" },
      last: { fragmentId: "fragment", blockId: "passage", anchor: "a" },
    });
  });

  it("isole les éditions et refuse un événement attribué à un autre appareil", async () => {
    await expect(
      projectProgressBatches(index, edition, [
        batch([event], { editionKey: "autre" }),
      ]),
    ).rejects.toThrow(/édition/u);
    await expect(
      projectProgressBatches(index, edition, [
        batch([{ ...event, deviceId: "autre" }]),
      ]),
    ).rejects.toThrow("Lot de progression invalide.");
  });

  it.each([
    "{",
    "null",
    "[]",
    batch([event], { schemaVersion: 2 }),
    batch([event], { deviceId: "" }),
    batch([event], { deviceId: "a".repeat(129) }),
    batch([]),
    batch(Array.from({ length: 501 }, () => event)),
    batch([null]),
    batch([{ ...event, clock: 0 }]),
    batch([{ ...event, clock: 1.25 }]),
    batch([{ ...event, kind: "remove" }]),
    batch([{ ...event, kind: "mode", scopeId: "premier", mode: "override" }]),
    batch([
      {
        ...event,
        kind: "visit",
        position: { fragmentId: "fragment", anchor: 2 },
      },
    ]),
    batch([{ ...event, samples: [] }]),
    batch([
      {
        ...event,
        samples: [{ unitId: "passage", elapsedMs: 2_000, coverage: 16 }],
      },
    ]),
    batch([
      {
        ...event,
        samples: [{ unitId: "passage", elapsedMs: 8_001, coverage: 1 }],
      },
    ]),
    batch([{ ...event, clock: Number.MAX_SAFE_INTEGER }]),
  ])("refuse une entrée non conforme", async (json) => {
    await expect(
      projectProgressBatches(index, edition, [json]),
    ).rejects.toThrow("Lot de progression invalide.");
  });

  it("refuse un fichier trop gros avant le décodage JSON", async () => {
    await expect(
      projectProgressBatches(index, edition, [" ".repeat(256_001)]),
    ).rejects.toThrow(/volumineux/u);
  });

  it("refuse un import de la même source dont les blocs de lecture diffèrent", async () => {
    const reimported: ReadingIndex = {
      ...index,
      fragments: { fragment: [{ id: "passage-réimporté", weight: 100 }] },
    };
    await expect(
      projectProgressBatches(reimported, edition, [batch()]),
    ).rejects.toThrow(/index/u);
  });
});
