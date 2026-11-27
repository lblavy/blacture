import "fake-indexeddb/auto";
import { createHash, webcrypto } from "node:crypto";
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
  exportBookBackup,
  exportEdition,
  exportPreviousEdition,
  listBooks,
  readDriveBinding,
  readDriveProgressCursor,
  readDriveSelections,
  readManifest,
  readProgress,
  readProgressJournal,
  readReadingIndex,
  removeLocalEdition,
  replaceEdition,
  restoreBookBackup,
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
const correctedManuscript = `${manuscript}
## Chapitre 37

Une nouvelle carte d’observation.
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
    predecessor?: string;
    source?: string;
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
  const faults = {
    loseProgressAcknowledgment: false,
    corruptResource: false,
    corruptProgress: false,
    unknownProgressUnit: false,
    legacyRevisionMetadata: false,
  };
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

  function advertisedFile(file: StoredFile): StoredFile {
    if (
      faults.legacyRevisionMetadata &&
      (file.descriptor.appProperties.predecessor ||
        file.descriptor.appProperties.source)
    ) {
      const descriptor = structuredClone(file.descriptor);
      delete descriptor.appProperties.predecessor;
      delete descriptor.appProperties.source;
      return { ...file, descriptor };
    }
    if (
      !faults.unknownProgressUnit ||
      file.descriptor.appProperties.kind !== "progress"
    )
      return file;
    const batch = JSON.parse(new TextDecoder().decode(file.body)) as {
      events: { samples?: ReadingSample[] }[];
    };
    const sample = batch.events.find(({ samples }) => samples?.length)
      ?.samples?.[0];
    if (!sample) return file;
    sample.unitId = "passage-synthetique-introuvable";
    const body = new TextEncoder().encode(JSON.stringify(batch));
    return {
      ...file,
      body,
      descriptor: {
        ...file.descriptor,
        size: String(body.byteLength),
        appProperties: {
          ...file.descriptor.appProperties,
          digest: createHash("sha256").update(body).digest("hex"),
        },
      },
    };
  }

  function readFile(account: string, url: URL, init?: RequestInit) {
    const stored = files.get(url.pathname.slice(resourcePath.length + 1));
    if (!stored || stored.account !== account)
      return new Response(null, { status: 404 });
    const file = advertisedFile(stored);
    if (url.searchParams.get("alt") !== "media")
      return Response.json(file.descriptor);
    const body = file.body.slice();
    const { kind } = file.descriptor.appProperties;
    if (
      (faults.corruptResource && kind === "resource") ||
      (faults.corruptProgress && kind === "progress")
    )
      body[0] = 0;
    const range = new Headers(init?.headers).get("Range");
    if (range) return readBodyPrefix(body, range);
    return new Response(body);
  }

  function readBodyPrefix(body: Uint8Array<ArrayBuffer>, range: string) {
    const inclusiveEnd = /^bytes=0-(\d+)$/u.exec(range)?.[1];
    if (inclusiveEnd === undefined) return new Response(null, { status: 416 });
    const size = Math.min(Number(inclusiveEnd) + 1, body.length);
    return new Response(body.slice(0, size), {
      status: 206,
      headers: { "Content-Range": `bytes 0-${size - 1}/${body.length}` },
    });
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
            .reverse()
            .filter((file) => file.account === account)
            .map((file) => advertisedFile(file).descriptor),
        });
      case uploadPath: {
        const id = url.searchParams.get("upload_id");
        return id
          ? finishUpload(account, id, init)
          : beginUpload(account, init);
      }
      default:
        expect(url.pathname).toMatch(/^\/drive\/v3\/files\/fixture-file-\d+$/);
        return readFile(account, url, init);
    }
  });
  return {
    createLibrary: () => createDriveLibrary(createDriveTransport(http)),
    http,
    counters,
    faults,
    editions: () =>
      [...files.values()]
        .filter(({ descriptor }) => descriptor.appProperties.kind === "edition")
        .map(({ descriptor, body }) => ({
          id: descriptor.id,
          hash: createHash("sha256").update(body).digest("hex"),
        })),
  };
}

function useReplica(database: IDBFactory) {
  vi.stubGlobal("indexedDB", database);
}

function transferBarrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  it.each([
    "actuelles",
    "anciennes sur petit fichier",
    "anciennes sur grand fichier",
  ])(
    "affiche la révision accessible sans doubler les mises à jour (métadonnées %s)",
    async (metadata) => {
      const replicaA = new IDBFactory();
      const replicaB = new IDBFactory();
      const publisher = new IDBFactory();
      const fixture = fixtureDrive();
      const library = fixture.createLibrary();
      const large = metadata === "anciennes sur grand fichier";
      const padding = large
        ? `\n\n## Annexe\n\n${"Constellations du ciel nocturne. ".repeat(700)}`
        : "";
      const original = await importMarkdown(`${manuscript}${padding}`);

      useReplica(publisher);
      const connection = await library.connect(tokens.primary);
      const editionA = await saveEdition(original);
      await library.synchronize(connection, editionA.key);
      const first = fixture.editions()[0]!;

      useReplica(replicaA);
      await library.download(connection, first.id);
      useReplica(publisher);
      const editionB = await replaceEdition(
        editionA.key,
        await importMarkdown(`${correctedManuscript}${padding}`),
      );
      await library.synchronize(connection, editionB.key);
      const second = fixture.editions()[1]!;

      useReplica(replicaB);
      expect(await library.download(connection, second.id)).toBe(editionB.key);
      useReplica(publisher);
      const editionC = await replaceEdition(editionB.key, original);
      expect(editionC.key).not.toBe(editionA.key);
      await library.synchronize(connection, editionC.key);
      const expected = fixture.editions();
      expect(expected).toHaveLength(3);
      const third = expected[2]!;
      const revised = (id: string) => ({
        key: id,
        title: `${title} · édition mise à jour`,
      });
      const legacy = metadata !== "actuelles";
      fixture.faults.legacyRevisionMetadata = legacy;
      fixture.http.mockClear();

      expect((await library.list(connection)).remote).toEqual([
        revised(third.id),
      ]);
      useReplica(new IDBFactory());
      expect((await library.list(connection)).remote).toEqual([
        revised(third.id),
      ]);
      useReplica(replicaA);
      expect((await library.list(connection)).remote).toEqual([
        revised(second.id),
      ]);
      useReplica(replicaB);
      expect((await library.list(connection)).remote).toEqual([
        revised(third.id),
      ]);
      expect(fixture.editions()).toEqual(expected);
      const mediaReads = fixture.http.mock.calls.filter(([input]) =>
        new URL(String(input)).searchParams.has("alt"),
      );
      if (legacy) {
        expect(
          mediaReads.map(([input]) => new URL(String(input)).pathname).sort(),
        ).toEqual([
          `${resourcePath}/${second.id}`,
          `${resourcePath}/${third.id}`,
        ]);
        expect(
          mediaReads.every(
            ([, init]) => new Headers(init?.headers).has("Range") === large,
          ),
        ).toBe(true);
      } else {
        expect(mediaReads).toEqual([]);
      }
    },
  );

  it("conserve deux ouvrages indépendants ayant le même titre", async () => {
    const fixture = fixtureDrive();
    const library = fixture.createLibrary();
    const connection = await library.connect(tokens.primary);
    const entries = [];
    for (const content of [manuscript, correctedManuscript]) {
      entries.push(await saveEdition(await importMarkdown(content, { title })));
    }
    for (const { key } of entries) await library.synchronize(connection, key);
    const files = fixture.editions();
    expect(files).toHaveLength(2);
    const { remote } = await library.list(connection);
    expect(remote).toHaveLength(2);
    expect(remote).toEqual(
      expect.arrayContaining(files.map(({ id }) => ({ key: id, title }))),
    );
  });

  it.each([false, true])(
    "regroupe deux publications de la même source séparées par une édition restée locale (anciens fichiers Drive : %s)",
    async (legacyRevisionMetadata) => {
      const fixture = fixtureDrive();
      const publisher = new IDBFactory();
      const reader = new IDBFactory();
      useReplica(publisher);
      const library = fixture.createLibrary();
      const connection = await library.connect(tokens.primary);
      const original = await importMarkdown(manuscript);
      const corrected = await importMarkdown(correctedManuscript);
      const editionA = await saveEdition(original);
      await library.synchronize(connection, editionA.key);
      const first = fixture.editions()[0]!;

      useReplica(reader);
      await library.download(connection, first.id);
      useReplica(publisher);
      const firstB = await replaceEdition(editionA.key, corrected);
      await library.synchronize(connection, firstB.key);
      const localA = await replaceEdition(firstB.key, original);
      const lastB = await replaceEdition(localA.key, corrected);
      expect(lastB.key).not.toBe(firstB.key);
      await library.synchronize(connection, lastB.key);
      const files = fixture.editions();
      expect(files).toHaveLength(3);
      fixture.faults.legacyRevisionMetadata = legacyRevisionMetadata;

      expect((await library.list(connection)).remote).toEqual([
        { key: files[2]!.id, title: `${title} · édition mise à jour` },
      ]);
      useReplica(new IDBFactory());
      expect((await library.list(connection)).remote).toEqual([
        { key: files[2]!.id, title: `${title} · édition mise à jour` },
      ]);
      useReplica(reader);
      expect((await library.list(connection)).remote).toEqual([
        { key: files[1]!.id, title: `${title} · édition mise à jour` },
      ]);
      expect(fixture.editions()).toEqual(files);
    },
  );

  it("conserve deux révisions divergentes issues du même prédécesseur", async () => {
    const fixture = fixtureDrive();
    const library = fixture.createLibrary();
    const connection = await library.connect(tokens.primary);
    const editionA = await saveEdition(await importMarkdown(manuscript));
    await library.synchronize(connection, editionA.key);
    const first = fixture.editions()[0]!;

    for (const content of [
      correctedManuscript,
      `${manuscript}\n## Chapitre 40\n\nDe nouvelles coordonnées.`,
    ]) {
      useReplica(new IDBFactory());
      await library.download(connection, first.id);
      const revision = await replaceEdition(
        editionA.key,
        await importMarkdown(content),
      );
      await library.synchronize(connection, revision.key);
    }
    const successors = fixture
      .editions()
      .slice(1)
      .map(({ id }) => id);
    expect(successors).toHaveLength(2);
    useReplica(new IDBFactory());
    expect(
      (await library.list(connection)).remote.map(({ key }) => key).sort(),
    ).toEqual(successors.sort());
    await library.download(connection, first.id);
    expect(
      (await library.list(connection)).remote.map(({ key }) => key).sort(),
    ).toEqual(successors);
  });

  it("fusionne deux migrations de la même édition sans recompter les anciennes lectures", async () => {
    const first = new IDBFactory();
    const second = new IDBFactory();
    const fixture = fixtureDrive();
    const corrected = await importMarkdown(correctedManuscript);
    const original = await importMarkdown(manuscript);

    useReplica(first);
    const publisher = fixture.createLibrary();
    const connectionA = await publisher.connect(tokens.primary);
    const { key } = await saveEdition(original);
    const { middleId } = await readChapter(key, "Chapitre 30", 3_000);
    await publisher.synchronize(connectionA, key);
    const oldFile = (await publisher.list(connectionA)).remote[0]!;

    useReplica(second);
    const receiver = fixture.createLibrary();
    const connectionB = await receiver.connect(tokens.primary);
    await expect(receiver.download(connectionB, oldFile.key)).resolves.toBe(
      key,
    );
    expect((await readProgress(key)).observations[middleId]?.elapsedMs).toBe(
      3_000,
    );
    await readChapter(key, "Chapitre 35", 2_000);
    const editionB = await replaceEdition(key, corrected);
    await readChapter(editionB.key, "Chapitre 35", 1_000);

    useReplica(first);
    await readChapter(key, "Chapitre 30", 1_000);
    const editionA = await replaceEdition(key, corrected);
    expect(editionA.key).toBe(editionB.key);
    expect(editionA.key).not.toBe(key);
    await readChapter(editionA.key, "Chapitre 30", 1_000);
    await publisher.synchronize(connectionA, editionA.key);

    useReplica(second);
    await receiver.synchronize(connectionB, editionB.key);
    const merged = await readProgress(editionB.key);
    expect(merged.observations[middleId]).toEqual({
      elapsedMs: 7_000,
      coverage: FULL_COVERAGE,
    });
    expect(await listBooks()).toMatchObject([{ key: editionB.key }]);
    expect(
      (await exportPreviousEdition(editionB.key))?.progress.observations[
        middleId
      ]?.elapsedMs,
    ).toBe(5_000);

    useReplica(first);
    const restarted = fixture.createLibrary();
    const renewed = await restarted.connect(tokens.renewed);
    await restarted.synchronize(renewed, editionA.key, true);
    expect(await readProgress(editionA.key)).toEqual(merged);
    expect(await listBooks()).toMatchObject([{ key: editionA.key }]);
    const archive = await exportPreviousEdition(editionA.key);
    expect(archive?.progress.observations[middleId]?.elapsedMs).toBe(4_000);
    expect(encodeEditionPackage(archive!.book)).toBe(
      encodeEditionPackage(original),
    );
    const publications = [...fixture.counters.publications];
    await restarted.synchronize(renewed, editionA.key, true);
    expect(await readProgress(editionA.key)).toEqual(merged);
    expect(fixture.counters.publications).toEqual(publications);
    expect(publications.filter((kind) => kind === "edition")).toHaveLength(2);
    expect(publications.filter((kind) => kind === "resource")).toHaveLength(1);
    expect((await restarted.list(renewed)).remote).not.toContainEqual(oldFile);

    useReplica(new IDBFactory());
    const archiveReader = fixture.createLibrary();
    const connectionC = await archiveReader.connect(tokens.primary);
    await expect(
      archiveReader.download(connectionC, oldFile.key),
    ).resolves.toBe(key);
    expect((await readProgress(key)).observations[middleId]?.elapsedMs).toBe(
      3_000,
    );
    expect(encodeEditionPackage(await exportEdition(key))).toBe(
      encodeEditionPackage(original),
    );
  });

  it("adopte la révision Drive avec accord, archive la copie locale et attend la prochaine synchronisation pour envoyer son suivi", async () => {
    const publisherDatabase = new IDBFactory();
    const readerDatabase = new IDBFactory();
    const fixture = fixtureDrive();
    const original = await importMarkdown(manuscript);
    const corrected = await importMarkdown(correctedManuscript);

    useReplica(publisherDatabase);
    const publisher = fixture.createLibrary();
    const publisherAccount = await publisher.connect(tokens.primary);
    const { key } = await saveEdition(original);
    const { middleId } = await readChapter(key, "Chapitre 30", 3_000);
    await publisher.synchronize(publisherAccount, key);
    const oldFile = (await publisher.list(publisherAccount)).remote[0]!;
    await readChapter(key, "Chapitre 30", 1_000);
    const revision = await replaceEdition(key, corrected);
    await readChapter(revision.key, "Chapitre 30", 750);
    await publisher.synchronize(publisherAccount, revision.key);
    const newFile = (await publisher.list(publisherAccount)).remote.find(
      (file) => file.key !== oldFile.key,
    )!;

    useReplica(readerDatabase);
    const reader = fixture.createLibrary();
    const readerAccount = await reader.connect(tokens.primary);
    await reader.download(readerAccount, oldFile.key);
    await readChapter(key, "Chapitre 35", 2_000);
    const beforeReplacement = await readProgress(key);
    expect(beforeReplacement.observations[middleId]?.elapsedMs).toBe(5_000);
    const publications = [...fixture.counters.publications];

    await expect(reader.download(readerAccount, newFile.key)).rejects.toThrow();
    const decline = vi.fn(() => false);
    await Promise.allSettled([
      reader.download(readerAccount, newFile.key, decline),
    ]);
    expect(decline).toHaveBeenCalledExactlyOnceWith(title);
    expect(await listBooks()).toMatchObject([{ key }]);
    expect(await readProgress(key)).toEqual(beforeReplacement);

    const accept = vi.fn(() => true);
    fixture.faults.corruptProgress = true;
    await expect(
      reader.download(readerAccount, newFile.key, accept),
    ).rejects.toThrow(/empreinte/u);
    expect(await listBooks()).toMatchObject([{ key }]);
    expect(await readProgress(key)).toEqual(beforeReplacement);
    expect(await exportPreviousEdition(revision.key)).toBeUndefined();
    fixture.faults.corruptProgress = false;

    fixture.faults.unknownProgressUnit = true;
    await expect(
      reader.download(readerAccount, newFile.key, accept),
    ).rejects.toThrow(/référence invalide/u);
    expect(await listBooks()).toMatchObject([{ key }]);
    expect(await readProgress(key)).toEqual(beforeReplacement);
    expect(await exportPreviousEdition(revision.key)).toBeUndefined();
    fixture.faults.unknownProgressUnit = false;

    const startTransfer = transferBarrier();
    const continueTransfer = transferBarrier();
    const normalFetch = fixture.http.getMockImplementation()!;
    let pauseNextDownload = false;
    fixture.http.mockImplementation(async (input, init) => {
      if (pauseNextDownload && new URL(String(input)).searchParams.has("alt")) {
        pauseNextDownload = false;
        startTransfer.release();
        await continueTransfer.promise;
      }
      return normalFetch(input, init);
    });
    accept.mockImplementationOnce(() => {
      pauseNextDownload = true;
      return true;
    });
    const adoption = reader.download(readerAccount, newFile.key, accept);
    try {
      await Promise.race([
        startTransfer.promise,
        adoption.then(() => {
          throw new Error(
            "Le transfert s’est terminé sans passer par la pause.",
          );
        }),
      ]);
      await readChapter(key, "Chapitre 35", 250);
    } finally {
      continueTransfer.release();
    }
    await expect(adoption).resolves.toBe(revision.key);
    expect(await listBooks()).toMatchObject([{ key: revision.key }]);
    expect(await readDriveSelections(primaryAccount)).toEqual([]);
    expect(fixture.counters.publications).toEqual(publications);
    const merged = await readProgress(revision.key);
    expect(merged.observations[middleId]?.elapsedMs).toBe(6_000);
    const previous = await exportPreviousEdition(revision.key);
    expect(previous?.progress).toMatchObject({
      ...beforeReplacement,
      observations: {
        ...beforeReplacement.observations,
        [middleId]: { elapsedMs: 5_250, coverage: FULL_COVERAGE },
      },
    });
    expect(encodeEditionPackage(previous!.book)).toBe(
      encodeEditionPackage(original),
    );
    accept.mockClear();
    await expect(
      reader.download(readerAccount, oldFile.key, accept),
    ).rejects.toThrow();
    expect(accept).not.toHaveBeenCalled();
    expect(await listBooks()).toMatchObject([{ key: revision.key }]);
    expect(await readProgress(revision.key)).toEqual(merged);
    await expect(reader.download(readerAccount, newFile.key)).resolves.toBe(
      revision.key,
    );
    expect(await readProgress(revision.key)).toEqual(merged);
    expect(fixture.counters.publications).toEqual(publications);

    await readChapter(revision.key, "Chapitre 35", 250);
    await reader.synchronize(readerAccount, revision.key);
    useReplica(publisherDatabase);
    const restarted = fixture.createLibrary();
    await restarted.synchronize(
      await restarted.connect(tokens.renewed),
      revision.key,
      true,
    );
    expect(
      (await readProgress(revision.key)).observations[middleId]?.elapsedMs,
    ).toBe(6_250);
    expect((await restarted.list(publisherAccount)).remote).not.toContainEqual(
      oldFile,
    );
  });

  it("renvoie une lecture restaurée même si elle était restée hors ligne", async () => {
    const fixture = fixtureDrive();
    const library = fixture.createLibrary();
    const { key } = await saveEdition(await importMarkdown(manuscript));
    const { middleId } = await readChapter(key, "Chapitre 30", 2000);
    const original = await library.connect(tokens.primary);
    await library.synchronize(original, key);
    await readChapter(key, "Chapitre 35", 1000);
    const backup = await exportBookBackup(key);

    useReplica(new IDBFactory());
    await restoreBookBackup(backup);
    const restored = await library.connect(tokens.primary);
    await library.synchronize(restored, key);
    const remote = (await library.list(restored)).remote[0]!;

    useReplica(new IDBFactory());
    const receiver = await library.connect(tokens.primary);
    await library.download(receiver, remote.key);
    expect((await readProgress(key)).observations[middleId]?.elapsedMs).toBe(
      3000,
    );
  });

  it("retrouve ses lectures Drive après retrait et réinstallation sur le même appareil", async () => {
    const fixture = fixtureDrive();
    const library = fixture.createLibrary();
    const account = await library.connect(tokens.primary);
    const { key } = await saveEdition(await importMarkdown(manuscript));
    const { middleId } = await readChapter(key, "Chapitre 30", 3_500);
    await library.synchronize(account, key);
    const saved = await readProgress(key);
    const device = (await readProgressJournal(key))!.deviceId;
    const remote = (await library.list(account)).remote[0]!;

    await removeLocalEdition(key);
    expect(await listBooks()).toEqual([]);
    expect((await library.list(account)).remote).toEqual([remote]);
    const restoredLibrary = fixture.createLibrary();
    const renewed = await restoredLibrary.connect(tokens.renewed);
    await expect(restoredLibrary.download(renewed, remote.key)).resolves.toBe(
      key,
    );
    expect(await readProgress(key)).toEqual(saved);
    expect((await readProgressJournal(key))?.deviceId).not.toBe(device);

    await readChapter(key, "Chapitre 35", 1_000);
    await restoredLibrary.synchronize(renewed, key);
    const merged = await readProgress(key);
    expect(merged.observations[middleId]?.elapsedMs).toBe(4_500);
    useReplica(new IDBFactory());
    const another = fixture.createLibrary();
    await another.download(await another.connect(tokens.primary), remote.key);
    expect(await readProgress(key)).toEqual(merged);
  });
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
