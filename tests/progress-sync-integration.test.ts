// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BOOK_SCOPE,
  FULL_COVERAGE,
  READING_TIME_MS,
  summarizeProgress,
  type ReadingIndex,
} from "../src/domain/progress";
import type { ProgressEvent } from "../src/domain/progress-sync";
import {
  fingerprintProgressIndex,
  projectProgressBatches,
} from "../src/sync/progress-batches";

const editionKey = JSON.stringify(["work-fixture", "edition-fixture"]);
const otherEditionKey = JSON.stringify(["work-fixture", "other-edition"]);
const windows = "83a4e0a2-4bf4-4a01-847d-e8ce417e8601";
const android = "83a4e0a2-4bf4-4a01-847d-e8ce417e8602";
const index: ReadingIndex = {
  sections: [
    { id: "chapter-30", parentId: null, fragmentIds: ["fragment-30"] },
    { id: "chapter-31", parentId: null, fragmentIds: ["fragment-31"] },
    { id: "chapter-35", parentId: null, fragmentIds: ["fragment-35"] },
  ],
  fragments: {
    "fragment-30": [{ id: "passage-30", weight: 100 }],
    "fragment-31": [{ id: "passage-31", weight: 100 }],
    "fragment-35": [{ id: "passage-35", weight: 100 }],
  },
};
const indexFingerprint = await fingerprintProgressIndex(index);

function encodeBatch(
  deviceId: string,
  events: readonly ProgressEvent[],
  key = editionKey,
  spaces = 0,
) {
  return JSON.stringify(
    { schemaVersion: 1, editionKey: key, indexFingerprint, deviceId, events },
    null,
    spaces,
  );
}

function reading(
  deviceId: string,
  clock: number,
  unitId: string,
  elapsedMs = READING_TIME_MS,
): ProgressEvent {
  return {
    kind: "observe",
    deviceId,
    clock,
    samples: [{ unitId, elapsedMs, coverage: FULL_COVERAGE }],
  };
}

describe("échange de lots de progression entre deux appareils simulés", () => {
  it("retrouve les chapitres 30 et 35 après livraison désordonnée et rejouement", async () => {
    const windowsIndex = structuredClone(index);
    const androidIndex = structuredClone(index);
    const windowsReads = [
      reading(windows, 1, "passage-30"),
      reading(windows, 2, "passage-31", 1_250),
      {
        kind: "visit",
        deviceId: windows,
        clock: 3,
        position: { fragmentId: "fragment-30", blockId: "passage-30" },
      },
    ] satisfies ProgressEvent[];
    const androidReads = [
      reading(android, 1, "passage-35"),
      reading(android, 2, "passage-31", 1_750),
    ];
    const windowsBatch = encodeBatch(windows, windowsReads);
    const androidBatch = encodeBatch(android, androidReads);

    const windowsOffline = summarizeProgress(
      windowsIndex,
      await projectProgressBatches(windowsIndex, editionKey, [windowsBatch]),
    );
    const androidOffline = summarizeProgress(
      androidIndex,
      await projectProgressBatches(androidIndex, editionKey, [androidBatch]),
    );
    expect(windowsOffline.sections["chapter-30"]?.status).toBe("complete");
    expect(windowsOffline.sections["chapter-35"]?.status).toBe("unstarted");
    expect(androidOffline.sections["chapter-30"]?.status).toBe("unstarted");
    expect(androidOffline.sections["chapter-35"]?.status).toBe("complete");

    const windowsOnline = await projectProgressBatches(
      windowsIndex,
      editionKey,
      [
        androidBatch,
        windowsBatch,
        encodeBatch(android, androidReads, editionKey, 2),
      ],
    );
    const androidOnline = await projectProgressBatches(
      androidIndex,
      editionKey,
      [windowsBatch, androidBatch, windowsBatch],
    );
    expect(androidOnline).toEqual(windowsOnline);
    expect(windowsOnline.observations["passage-31"]).toEqual({
      elapsedMs: 3_000,
      coverage: FULL_COVERAGE,
    });
    expect(windowsOnline.last).toEqual({
      fragmentId: "fragment-30",
      blockId: "passage-30",
    });

    const summary = summarizeProgress(windowsIndex, windowsOnline);
    expect(summary.sections["chapter-30"]?.status).toBe("complete");
    expect(summary.sections["chapter-35"]?.status).toBe("complete");
    expect(summary.firstUnread).toEqual({
      fragmentId: "fragment-31",
      blockId: "passage-31",
    });
  });

  it("conserve les observations et la correction d’un autre appareil", async () => {
    const markedUnread = encodeBatch(windows, [
      reading(windows, 1, "passage-30"),
      {
        kind: "mode",
        deviceId: windows,
        clock: 2,
        scopeId: BOOK_SCOPE,
        mode: "unread",
      },
    ]);
    const corrected = encodeBatch(android, [
      {
        kind: "mode",
        deviceId: android,
        clock: 3,
        scopeId: "chapter-30",
        mode: "auto",
      },
    ]);
    const state = await projectProgressBatches(index, editionKey, [
      corrected,
      markedUnread,
      corrected,
    ]);
    expect(summarizeProgress(index, state).sections["chapter-30"]?.status).toBe(
      "complete",
    );
    expect(state.modes).toEqual({
      [BOOK_SCOPE]: "unread",
      "chapter-30": "auto",
    });
    expect(state.observations["passage-30"]?.elapsedMs).toBe(READING_TIME_MS);
  });

  it("permet de rejouer un transfert interrompu sans modifier la projection locale", async () => {
    const localBatch = encodeBatch(windows, [
      reading(windows, 1, "passage-30"),
    ]);
    const remoteBatch = encodeBatch(android, [
      reading(android, 1, "passage-35"),
    ]);
    const local = await projectProgressBatches(index, editionKey, [localBatch]);
    const before = structuredClone(local);

    await expect(
      projectProgressBatches(index, editionKey, [
        localBatch,
        remoteBatch.slice(0, -2),
      ]),
    ).rejects.toThrow("Lot de progression invalide.");
    expect(local).toEqual(before);
    expect(
      await projectProgressBatches(index, editionKey, [localBatch]),
    ).toEqual(before);
    const retry = await projectProgressBatches(index, editionKey, [
      localBatch,
      remoteBatch,
    ]);
    expect(retry.observations["passage-30"]).toBeDefined();
    expect(retry.observations["passage-35"]).toBeDefined();
  });

  it("rejette le lot d’une autre édition même si les identifiants de blocs concordent", async () => {
    const wrongBatch = encodeBatch(
      android,
      [reading(android, 1, "passage-30")],
      otherEditionKey,
    );
    await expect(
      projectProgressBatches(index, editionKey, [wrongBatch]),
    ).rejects.toThrow(/autre édition/u);
    const local = await projectProgressBatches(index, editionKey, []);
    expect(local.observations).toEqual({});
  });
});
