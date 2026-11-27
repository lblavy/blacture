// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  decodeBookArchive,
  encodeBookArchive,
  inspectBookArchive,
} from "../src/backup/book-archive";
import { EMPTY_PROGRESS, type ProgressState } from "../src/domain/progress";
import type { ProgressEvent } from "../src/domain/progress-sync";
import { importMarkdown } from "../src/import";
import { sha256 } from "../src/import/identity";

const largePng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR4nGPQja9FQ89O9KAhhlFFAIjAnJFx1hCGAAAAAElFTkSuQmCC";
const smallPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=";
const imported = await importMarkdown(
  `# Une île — 道

![L’île](${largePng})

## Son phare {#phare}

![Lumière](${smallPng})
`,
);
const first = imported.fragments[0]!;
const progress: ProgressState = {
  observations: { [first.blockIds[0]!]: { elapsedMs: 3000, coverage: 1 } },
  modes: {},
  last: { fragmentId: first.id },
};
const events: ProgressEvent[] = [
  {
    kind: "visit",
    deviceId: "test-device",
    clock: 1,
    position: progress.last!,
  },
];
const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function archive() {
  return encodeBookArchive({ book: imported, progress, events });
}

async function alter(
  change: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
) {
  const bytes = new Uint8Array(await (await archive()).arrayBuffer());
  await change(bytes);
  return new Blob([bytes]);
}

async function replaceReading(value: unknown) {
  const saved = await archive();
  const bytes = new Uint8Array(await saved.arrayBuffer());
  const header = new DataView(bytes.buffer);
  const start = 80 + header.getUint32(8);
  const end = start + header.getUint32(12);
  const reading = encoder.encode(JSON.stringify(value));
  const digest = await sha256(reading);
  for (let i = 0; i < 32; i++)
    bytes[48 + i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  header.setUint32(12, reading.length);
  return new Blob([bytes.subarray(0, start), reading, bytes.subarray(end)]);
}

describe("archive locale d’un ouvrage", () => {
  it("vérifie un ouvrage Unicode avec ses images, la progression et le journal", async () => {
    const saved = await archive();
    expect(await inspectBookArchive(saved)).toEqual({
      title: "Une île — 道",
      resourceCount: 2,
      hasProgress: true,
    });
    const bytes = new Uint8Array(await saved.arrayBuffer());
    const header = new DataView(bytes.buffer);
    const editionEnd = 80 + header.getUint32(8);
    const readingEnd = editionEnd + header.getUint32(12);
    expect(decoder.decode(bytes.subarray(0, 8))).toBe("BLACBK01");
    expect(
      JSON.parse(decoder.decode(bytes.subarray(editionEnd, readingEnd))),
    ).toEqual({
      progress,
      events,
    });
    let offset = readingEnd;
    const ordered = [...imported.resources].sort((a, b) =>
      a.id < b.id ? -1 : 1,
    );
    for (const resource of ordered) {
      const end = offset + resource.bytes.length;
      expect(bytes.subarray(offset, end)).toEqual(resource.bytes);
      offset = end;
    }
    expect(offset).toBe(saved.size);
  });

  it("reconnaît une archive sans progression ni image", async () => {
    const book = await importMarkdown("# Bord de mer\n\nUn rocher.");
    const saved = await encodeBookArchive({
      book,
      progress: EMPTY_PROGRESS,
      events: [],
    });
    expect(await inspectBookArchive(saved)).toEqual({
      title: "Bord de mer",
      resourceCount: 0,
      hasProgress: false,
    });
  });

  it("décode l’édition et les lectures restaurables en conservant les identifiants", async () => {
    const second = imported.fragments[1]!;
    const position = {
      fragmentId: second.id,
      anchor: imported.destinations.phare!.elementId,
    };
    const snapshot = {
      progress: {
        ...progress,
        modes: { "@book": "read" as const },
        last: position,
      },
      events: [
        ...events,
        {
          kind: "mode",
          deviceId: "test-device",
          clock: 2,
          scopeId: "@book",
          mode: "read",
        },
        {
          kind: "observe",
          deviceId: "other-device",
          clock: 1,
          samples: [
            { unitId: first.blockIds[0]!, elapsedMs: 3000, coverage: 1 },
          ],
        },
        { kind: "visit", deviceId: "test-device", clock: 3, position },
      ] satisfies ProgressEvent[],
    };
    const restored = await decodeBookArchive(await replaceReading(snapshot));
    expect(restored.progress).toEqual(snapshot.progress);
    expect(restored.events).toEqual(snapshot.events);
    expect(restored.book).toEqual({
      ...imported,
      resources: [...imported.resources].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    });
  });

  it("conserve le point de retour généré pour un renvoi et refuse un point inexistant", async () => {
    const book = await importMarkdown(
      "# Parc\n\n[Aller au verger](#verger).\n\n## Verger {#verger}\n\nUn pommier.",
    );
    const fragmentId = book.fragments[0]!.id;
    for (const [anchor, accepted] of [
      ["blacture-reference-1", true],
      ["blacture-reference-2", false],
    ] as const) {
      const progress = { ...EMPTY_PROGRESS, last: { fragmentId, anchor } };
      const file = await encodeBookArchive({ book, progress, events: [] });
      const reading = decodeBookArchive(file);
      if (accepted) await expect(reading).resolves.toMatchObject({ progress });
      else
        await expect(reading).rejects.toThrow(
          "Progression de la sauvegarde invalide",
        );
    }
  });

  it("conserve l’origine des lectures et corrections migrées", async () => {
    const [unitId] = first.blockIds;
    const migration = [
      {
        kind: "migrate",
        deviceId: "test-device",
        clock: 1,
        samples: [{ unitId: unitId!, elapsedMs: 3000, coverage: 1 }],
      },
      {
        kind: "mode",
        deviceId: "test-device",
        clock: 2,
        scopeId: "@book",
        mode: "unread",
        inherited: true,
      },
      {
        kind: "visit",
        deviceId: "test-device",
        clock: 3,
        position: progress.last!,
        inherited: true,
      },
    ] satisfies ProgressEvent[];
    await expect(
      decodeBookArchive(await replaceReading({ progress, events: migration })),
    ).resolves.toMatchObject({ events: migration });
  });

  it.each([
    {
      progress: {
        ...progress,
        observations: { absent: { elapsedMs: 50, coverage: 1 } },
      },
      events,
    },
    {
      progress: {
        ...progress,
        observations: {
          [first.blockIds[0]!]: { elapsedMs: 9000, coverage: 1 },
        },
      },
      events,
    },
    { progress: { ...progress, modes: { absent: "read" } }, events },
    { progress: { ...progress, modes: { "@book": "done" } }, events },
    { progress: { ...progress, last: { fragmentId: "absent" } }, events },
    {
      progress: {
        ...progress,
        last: { fragmentId: first.id, blockId: "absent" },
      },
      events,
    },
    {
      progress: {
        ...progress,
        last: { fragmentId: first.id, anchor: "absent" },
      },
      events,
    },
    { progress, events: [{ ...events[0], clock: 0 }] },
    { progress, events: [{ ...events[0], kind: "unknown" }] },
    {
      progress,
      events: [
        ...events,
        { ...events[0], position: { fragmentId: imported.fragments[1]!.id } },
      ],
    },
    {
      progress,
      events: [
        {
          kind: "migrate",
          deviceId: "test-device",
          clock: 1,
          samples: [{ unitId: "absent", elapsedMs: 100, coverage: 1 }],
        },
      ],
    },
    {
      progress,
      events: [
        {
          kind: "observe",
          deviceId: "test-device",
          clock: 1,
          samples: [{ unitId: "absent", elapsedMs: 100, coverage: 1 }],
        },
      ],
    },
  ])(
    "refuse les références ou les événements de lecture invalides (%#)",
    async (snapshot) => {
      const invalid = await replaceReading(snapshot);
      await expect(decodeBookArchive(invalid)).rejects.toThrow();
    },
  );

  it.each([
    ["signature", 0],
    ["empreinte édition", 16],
    ["empreinte lecture", 48],
    ["document", 82],
    ["image", -1],
  ] as const)(
    "refuse une archive dont %s est altérée",
    async (_label, index) => {
      const corrupted = await alter((bytes) => {
        const offset = index === -1 ? bytes.length - 1 : index;
        bytes[offset] = bytes[offset]! ^ 1;
      });
      await expect(inspectBookArchive(corrupted)).rejects.toThrow();
    },
  );

  it("refuse la troncature, les octets superflus et une longueur démesurée", async () => {
    const saved = await archive();
    for (const invalid of [
      saved.slice(0, 6),
      saved.slice(0, 81),
      saved.slice(0, -1),
      new Blob([saved, "suite"]),
      await alter((bytes) =>
        new DataView(bytes.buffer).setUint32(8, 0xffffffff),
      ),
    ])
      await expect(inspectBookArchive(invalid)).rejects.toThrow();
  });

  it("rejette des données de lecture déformées même si leur empreinte correspond", async () => {
    const invalid = await replaceReading({ progress: [], events: [] });
    await expect(inspectBookArchive(invalid)).rejects.toThrow();
  });

  it("respecte l’annulation avant et pendant l’opération", async () => {
    const saved = await archive();
    const stopped = new Error("Essai annulé");
    const signal = AbortSignal.abort(stopped);
    await expect(inspectBookArchive(saved, signal)).rejects.toBe(stopped);
    await expect(
      encodeBookArchive({ book: imported, progress, events }, signal),
    ).rejects.toBe(stopped);

    const controller = new AbortController();
    const pending = inspectBookArchive(saved, controller.signal);
    controller.abort(stopped);
    await expect(pending).rejects.toBe(stopped);
  });
});
