import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FULL_COVERAGE,
  READING_TIME_MS,
  observeReadings,
  setLastConsultation,
  summarizeProgress,
  type ReadingSample,
} from "../src/domain/progress";
import { importMarkdown } from "../src/import";
import {
  exportEdition,
  listBooks,
  readDriveBinding,
  readDriveProgressCursor,
  readManifest,
  readProgress,
  readReadingIndex,
  saveEdition,
  updateProgress,
} from "../src/storage";
import { createDriveLibrary } from "../src/sync/drive-library";
import { createDriveTransport } from "../src/sync/drive-transport";
import { encodeEditionPackage } from "../src/sync/edition-package";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR4nGPQja9FQ89O9KAhhlFFAIjAnJFx1hCGAAAAAElFTkSuQmCC";
const title = "Manuel imaginaire des constellations";
const manuscript = `# ${title}

![Image du ciel](${png})

[Consulter la carte](#carte).

## Chapitre 30 {#carte}

Chercher les étoiles à l’est.

## Chapitre 31

Observer l’horizon sans précipitation.

## Chapitre 35

Reconnaître les étoiles à l’ouest.
`;
const tokens = {
  primary: { token: "controle-synthetique-principal" },
  renewed: { token: "controle-synthetique-renouvele" },
  other: { token: "controle-synthetique-secondaire" },
};
const primaryAccount = "fixture-account-a";
const googleOrigin = "https://www.googleapis.com";
const uploadPath = "/upload/drive/v3/files";
const resourcePath = "/drive/v3/files";

interface FixtureDescriptor {
  id: string;
  name: string;
  size: string;
  appProperties: {
    blacture: string;
    kind: string;
    digest: string;
    edition?: string;
  };
}

interface StoredFile {
  account: string;
  descriptor: FixtureDescriptor;
  body: Uint8Array<ArrayBuffer>;
}

function requestAccount(init: RequestInit | undefined) {
  const authorization = new Headers(init?.headers).get("Authorization");
  if (authorization === `Bearer ${tokens.other.token}`)
    return "fixture-account-b";
  expect([
    `Bearer ${tokens.primary.token}`,
    `Bearer ${tokens.renewed.token}`,
  ]).toContain(authorization);
  return primaryAccount;
}

function fixtureDrive() {
  const files = new Map<string, StoredFile>();
  const pending = new Map<string, Omit<StoredFile, "body">>();
  const faults = { loseProgressAcknowledgment: false, corruptResource: false };
  const counters = { reservations: 0, publications: [] as string[] };

  function beginUpload(account: string, init: RequestInit | undefined) {
    const descriptor = JSON.parse(String(init?.body)) as FixtureDescriptor;
    expect(init?.method).toBe("POST");
    expect(descriptor.appProperties.blacture).toBe("1");
    if (files.has(descriptor.id)) return new Response(null, { status: 409 });
    const size = new Headers(init?.headers).get("X-Upload-Content-Length");
    expect(size).toMatch(/^\d+$/);
    pending.set(descriptor.id, {
      account,
      descriptor: { ...descriptor, size: size! },
    });
    return new Response(null, {
      headers: {
        Location: `${googleOrigin}${uploadPath}?upload_id=${descriptor.id}`,
      },
    });
  }

  function uploadStatus(account: string, id: string) {
    const committed = files.get(id);
    if (committed?.account === account)
      return Response.json(committed.descriptor);
    return new Response(null, {
      status: pending.get(id)?.account === account ? 308 : 404,
    });
  }

  function finishUpload(account: string, id: string, init: RequestInit = {}) {
    const { method, headers, body } = init;
    expect(method).toBe("PUT");
    const range = new Headers(headers).get("Content-Range") ?? "";
    if (range.startsWith("bytes */")) return uploadStatus(account, id);
    const record = pending.get(id);
    if (!record || record.account !== account)
      return new Response(null, { status: 404 });
    const size = Number(record.descriptor.size);
    expect(range).toBe(`bytes 0-${size - 1}/${size}`);
    expect(ArrayBuffer.isView(body)).toBe(true);
    const bytes = new Uint8Array(body as Uint8Array<ArrayBuffer>);
    expect(bytes.length).toBe(size);
    files.set(id, { ...record, body: bytes });
    pending.delete(id);
    const { kind } = record.descriptor.appProperties;
    counters.publications.push(kind);
    if (kind === "progress" && faults.loseProgressAcknowledgment) {
      faults.loseProgressAcknowledgment = false;
      return new Response(null, { status: 503 });
    }
    return Response.json(record.descriptor);
  }

  function readFile(account: string, url: URL) {
    const file = files.get(url.pathname.slice(resourcePath.length + 1));
    if (!file || file.account !== account)
      return new Response(null, { status: 404 });
    if (url.searchParams.get("alt") !== "media")
      return Response.json(file.descriptor);
    const body = file.body.slice();
    if (
      faults.corruptResource &&
      file.descriptor.appProperties.kind === "resource"
    )
      body[0] = 0;
    return new Response(body);
  }

  const http = vi.fn<typeof fetch>(async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    expect(url.origin).toBe(googleOrigin);
    const account = requestAccount(init);
    switch (url.pathname) {
      case "/drive/v3/about":
        return Response.json({ user: { permissionId: account } });
      case `${resourcePath}/generateIds`:
        return Response.json({
          ids: [`fixture-file-${++counters.reservations}`],
        });
      case resourcePath:
        return Response.json({
          files: [...files.values()]
            .filter((file) => file.account === account)
            .map((file) => file.descriptor),
        });
      case uploadPath: {
        const id = url.searchParams.get("upload_id");
        return id
          ? finishUpload(account, id, init)
          : beginUpload(account, init);
      }
      default:
        expect(url.pathname).toMatch(/^\/drive\/v3\/files\/fixture-file-\d+$/);
        return readFile(account, url);
    }
  });
  return {
    createLibrary: () => createDriveLibrary(createDriveTransport(http)),
    http,
    counters,
    faults,
  };
}

function useReplica(database: IDBFactory) {
  vi.stubGlobal("indexedDB", database);
}

async function indexFor(key: string) {
  const manifest = await readManifest(key);
  if (!manifest) throw new Error("Fixture locale absente.");
  return { manifest, index: await readReadingIndex(key, manifest) };
}

async function readChapter(key: string, chapter: string, partial: number) {
  const { index, manifest } = await indexFor(key);
  const fragmentId = manifest.sections.find(
    (section) => section.title === chapter,
  )!.fragmentIds[0]!;
  const blockId = index.fragments[fragmentId]![0]!.id;
  const middleFragment = manifest.sections.find(
    (section) => section.title === "Chapitre 31",
  )!.fragmentIds[0]!;
  const middleId = index.fragments[middleFragment]![0]!.id;
  const samples: ReadingSample[] = [
    { unitId: blockId, elapsedMs: READING_TIME_MS, coverage: FULL_COVERAGE },
    { unitId: middleId, elapsedMs: partial, coverage: FULL_COVERAGE },
  ];
  const position = { fragmentId, blockId };
  await updateProgress(key, (previous) => ({
    state: setLastConsultation(
      index,
      observeReadings(index, previous, samples),
      position,
    ),
    events: [
      { kind: "observe", samples },
      { kind: "visit", position },
    ],
  }));
  return { middleId, position };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  useReplica(new IDBFactory());
});

afterEach(() => vi.unstubAllGlobals());

describe("transferts Drive avec deux répliques IndexedDB et HTTP simulé", () => {
  it("importe une fois, fusionne les lectures hors ligne et reprend après la perte de l’accusé de transfert", async () => {
    const deviceA = new IDBFactory();
    const deviceB = new IDBFactory();
    const fake = fixtureDrive();

    useReplica(deviceA);
    const libraryA = fake.createLibrary();
    const accountA = await libraryA.connect(tokens.primary);
    expect(await readDriveBinding()).toBeUndefined();
    const original = await importMarkdown(manuscript);
    const { key } = await saveEdition(original);
    await libraryA.synchronize(accountA, key);
    expect(fake.counters.publications).toEqual(["resource", "edition"]);
    expect(await readDriveBinding()).toBe(primaryAccount);

    useReplica(deviceB);
    const libraryB = fake.createLibrary();
    const accountB = await libraryB.connect(tokens.primary);
    const catalog = await libraryB.list(accountB);
    expect(catalog.local).toEqual([]);
    expect(catalog.remote).toEqual([{ key: expect.any(String), title }]);
    expect(await libraryB.download(accountB, catalog.remote[0]!.key)).toBe(key);
    expect(encodeEditionPackage(await exportEdition(key))).toBe(
      encodeEditionPackage(original),
    );
    const restored = await exportEdition(key);
    expect(Array.from(restored.resources[0]!.bytes)).toEqual(
      Array.from(original.resources[0]!.bytes),
    );
    const readingB = await readChapter(key, "Chapitre 35", 1_750);

    useReplica(deviceA);
    const readingA = await readChapter(key, "Chapitre 30", 1_250);
    const beforeFailure = await readProgress(key);
    fake.faults.loseProgressAcknowledgment = true;
    await expect(
      libraryA.synchronize(accountA, key, true),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(await readProgress(key)).toEqual(beforeFailure);
    expect(await readDriveProgressCursor(primaryAccount, key)).toEqual({
      sentThrough: 0,
      pendingThrough: 2,
    });

    useReplica(deviceB);
    await libraryB.synchronize(accountB, key, true);
    const mergedB = await readProgress(key);
    expect(mergedB.observations[readingB.middleId]).toEqual({
      elapsedMs: 3_000,
      coverage: FULL_COVERAGE,
    });

    useReplica(deviceA);
    const restarted = fake.createLibrary();
    const renewed = await restarted.connect(tokens.renewed);
    await restarted.synchronize(renewed, key, true);
    const mergedA = await readProgress(key);
    expect(mergedA).toEqual(mergedB);
    expect(mergedA.observations[readingA.middleId]?.elapsedMs).toBe(3_000);
    expect([readingA.position, readingB.position]).toContainEqual(mergedA.last);
    const { index, manifest } = await indexFor(key);
    const summarized = summarizeProgress(index, mergedA);
    for (const chapter of ["Chapitre 30", "Chapitre 35"]) {
      const id = manifest.sections.find(
        (section) => section.title === chapter,
      )!.id;
      expect(summarized.sections[id]?.status).toBe("complete");
    }
    expect(await readDriveProgressCursor(primaryAccount, key)).toEqual({
      sentThrough: 2,
    });
    await restarted.synchronize(renewed, key, true);
    useReplica(deviceB);
    await libraryB.synchronize(accountB, key, true);
    expect(await readProgress(key)).toEqual(mergedB);
    expect(fake.counters.publications).toEqual([
      "resource",
      "edition",
      "progress",
      "progress",
    ]);
    expect(fake.counters.reservations).toBe(4);
  });

  it("n’insère pas d’ouvrage partiel quand l’image échoue au contrôle et permet de réessayer", async () => {
    const fake = fixtureDrive();
    const library = fake.createLibrary();
    const account = await library.connect(tokens.primary);
    const { key } = await saveEdition(await importMarkdown(manuscript));
    await library.synchronize(account, key);
    const { remote } = await library.list(account);

    useReplica(new IDBFactory());
    const otherReplica = fake.createLibrary();
    const reader = await otherReplica.connect(tokens.renewed);
    fake.faults.corruptResource = true;
    await expect(otherReplica.download(reader, remote[0]!.key)).rejects.toThrow(
      /empreinte/u,
    );
    expect(await listBooks()).toEqual([]);
    fake.faults.corruptResource = false;
    await expect(otherReplica.download(reader, remote[0]!.key)).resolves.toBe(
      key,
    );
    expect(await listBooks()).toMatchObject([{ key, title }]);
  });

  it("refuse un autre compte sur une bibliothèque liée avant toute lecture de son catalogue", async () => {
    const fake = fixtureDrive();
    const library = fake.createLibrary();
    const primary = await library.connect(tokens.primary);
    const entry = await saveEdition(await importMarkdown(manuscript));
    await library.synchronize(primary, entry.key);
    const requestCount = fake.http.mock.calls.length;

    await expect(library.connect(tokens.other)).rejects.toThrow(
      /autre compte/u,
    );
    expect(fake.http.mock.calls.length).toBe(requestCount + 1);
    expect(String(fake.http.mock.calls.at(-1)?.[0])).toContain(
      "/drive/v3/about",
    );
    expect(await listBooks()).toEqual([entry]);
    expect(await readDriveBinding()).toBe(primaryAccount);
  });

  it("réévalue l’association avant le listing d’un onglet connecté plus tôt", async () => {
    const fake = fixtureDrive();
    const firstTab = fake.createLibrary();
    const secondTab = fake.createLibrary();
    const staleAccount = await secondTab.connect(tokens.other);
    const primary = await firstTab.connect(tokens.primary);
    const entry = await saveEdition(await importMarkdown(manuscript));
    await firstTab.synchronize(primary, entry.key);
    const requestCount = fake.http.mock.calls.length;

    await expect(secondTab.list(staleAccount)).rejects.toThrow(/autre compte/u);
    expect(fake.http.mock.calls).toHaveLength(requestCount);
    expect(await readDriveBinding()).toBe(primaryAccount);
  });
});
