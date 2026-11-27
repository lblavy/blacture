// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ReadingIndex } from "../src/domain/progress";
import {
  fingerprintProgressIndex,
  nextProgressBatch,
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
  kind: "observe" as const,
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

  it("laisse les lots ordinaires en version 1 et écrit les migrations en version 2", async () => {
    const migrated = { ...event, clock: 2, kind: "migrate" as const };
    const cursor = { sentThrough: 0 };
    const journal = { deviceId: event.deviceId, events: [event, migrated] };
    const first = nextProgressBatch(edition, indexFingerprint, journal, {
      ...cursor,
      pendingThrough: 1,
    });
    const second = nextProgressBatch(
      edition,
      indexFingerprint,
      journal,
      cursor,
    );
    const decoder = new TextDecoder();
    const recent = decoder.decode(second?.bytes);
    expect(JSON.parse(decoder.decode(first?.bytes))).toMatchObject({
      schemaVersion: 1,
    });
    expect(JSON.parse(recent)).toMatchObject({
      schemaVersion: 2,
      events: [event, migrated],
    });
    expect(
      await projectProgressBatches(index, edition, [batch(), recent]),
    ).toMatchObject({
      observations: { passage: { elapsedMs: 4_000, coverage: 3 } },
    });
  });

  it("utilise la version 2 pour une commande héritée sans observation migrée", async () => {
    const inherited = {
      kind: "mode" as const,
      deviceId: event.deviceId,
      clock: 6,
      scopeId: "premier",
      mode: "unread" as const,
      inherited: true as const,
    };
    const encoded = nextProgressBatch(
      edition,
      indexFingerprint,
      {
        deviceId: event.deviceId,
        events: [inherited],
      },
      { sentThrough: 0 },
    );
    const json = new TextDecoder().decode(encoded?.bytes);
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 2,
      events: [inherited],
    });
    const correction = {
      ...inherited,
      inherited: undefined,
      clock: 1,
      mode: "read",
    };
    await expect(
      projectProgressBatches(index, edition, [json, batch([correction])]),
    ).resolves.toMatchObject({ modes: { premier: "read" } });
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
    batch([event], { schemaVersion: 3 }),
    batch([{ ...event, kind: "migrate" }]),
    batch([{ ...event, kind: "migrate", samples: [] }], { schemaVersion: 2 }),
    batch([
      {
        ...event,
        kind: "mode",
        scopeId: "premier",
        mode: "read",
        inherited: true,
      },
    ]),
    batch(
      [
        {
          ...event,
          kind: "mode",
          scopeId: "premier",
          mode: "read",
          inherited: false,
        },
      ],
      { schemaVersion: 2 },
    ),
    batch([{ ...event, inherited: true }], { schemaVersion: 2 }),
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
