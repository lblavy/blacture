import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOK_SCOPE,
  FULL_COVERAGE,
  changeMode,
  observeReading,
  type ReadingIndex,
} from "../src/domain/progress";
import type { ProgressEvent } from "../src/domain/progress-sync";
import type { ImportedBook } from "../src/import";
import { createFragmentRenderer } from "../src/fragment-preview";
import { maxProgressClock } from "../src/sync/local-progress";
import {
  applyRemoteProgress,
  bindDriveAccount,
  ensureProgressJournal,
  exportBookBackup,
  exportEdition,
  exportPreviousEdition,
  listBooks,
  readDriveBinding,
  readDriveProgressCursor,
  readDriveSelections,
  readDriveTicket,
  readFontSize,
  readFragment,
  readManifest,
  readProgress,
  readProgressJournal,
  readReadingIndex,
  readResources,
  removeLocalEdition,
  replaceEdition,
  restoreBookBackup,
  saveEdition,
  saveFontSize,
  trackDriveEdition,
  updateProgress,
  writeDriveProgressCursor,
  writeDriveTicket,
} from "../src/storage";

function book(id = "edition-1"): ImportedBook {
  return {
    schemaVersion: 1,
    workId: "work-1",
    editionId: id,
    title: "Un livre",
    sections: [
      {
        id: "section",
        title: "Introduction",
        parentId: null,
        level: 1,
        fragmentIds: ["first"],
      },
    ],
    fragments: [
      {
        id: "first",
        sectionId: "section",
        html: "<p>Texte.</p>",
        blockIds: ["p"],
        resourceIds: ["image"],
      },
    ],
    destinations: { intro: { elementId: "intro", fragmentId: "first" } },
    resources: [
      { id: "image", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ],
    diagnostics: [],
  };
}

function plainEdition(edition: ImportedBook) {
  return {
    ...edition,
    resources: edition.resources.map((resource) => ({
      ...resource,
      bytes: Array.from(resource.bytes),
    })),
  };
}

async function resetDatabase() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("blacture-library");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function seedDriveStores(tx: IDBTransaction, key: string) {
  const db = tx.db;
  tx.objectStore("preferences").add("compte-v4", "drive-account-binding");
  db.createObjectStore("progress-journal-heads").add(
    { deviceId: "appareil-v4", clock: 7 },
    key,
  );
  db.createObjectStore("progress-journal-events").add(
    {
      deviceId: "appareil-v4",
      clock: 7,
      kind: "visit",
      position: { fragmentId: "first", blockId: "p" },
    },
    [key, 7],
  );
  db.createObjectStore("progress-remote-events");
  db.createObjectStore("drive-transfer-tickets");
  db.createObjectStore("drive-progress-cursors").add({ sentThrough: 7 }, [
    "compte-v4",
    key,
  ]);
  db.createObjectStore("drive-edition-selections").add(
    [key],
    ["compte-v4", "selected-editions"],
  );
}

async function seedLegacyEdition(source: ImportedBook, version: 1 | 2 | 3 | 4) {
  const key = JSON.stringify([source.workId, source.editionId]);
  const { fragments, resources, ...manifest } = source;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("blacture-library", version);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("catalog").add(
        {
          key,
          title: source.title,
          firstFragmentId: "first",
          resourceBytes: 3,
        },
        key,
      );
      db.createObjectStore("manifests").add(manifest, key);
      db.createObjectStore("fragments").add(fragments[0], [key, "first"]);
      db.createObjectStore("resources").add(resources[0], [key, "image"]);
      if (version >= 2)
        db.createObjectStore("preferences").add("small", "font-size");
      if (version >= 3) {
        db.createObjectStore("progress").add(
          {
            observations: { p: { elapsedMs: 4000, coverage: 3 } },
            modes: { child: "read", [BOOK_SCOPE]: "unread", section: "auto" },
            last: { fragmentId: "first", blockId: "p" },
          },
          key,
        );
        db.createObjectStore("reading-indexes").add(
          {
            sections: source.sections,
            fragments: { first: [{ id: "p", weight: 6 }] },
          },
          key,
        );
      }
      if (version === 4) seedDriveStores(request.transaction!, key);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  return { key, manifest, fragments, resources };
}

describe("publication atomique d’une édition", () => {
  beforeEach(resetDatabase);

  it("ouvre une base B06 sans perdre le contenu, la sélection Drive ni son curseur", async () => {
    const { key } = await seedLegacyEdition(book(), 4);
    expect(await readDriveBinding()).toBe("compte-v4");
    expect(await readDriveSelections("compte-v4")).toEqual([key]);
    expect(await readDriveProgressCursor("compte-v4", key)).toEqual({
      sentThrough: 7,
    });
    expect(await readProgressJournal(key)).toMatchObject({
      deviceId: "appareil-v4",
      events: [{ clock: 7, kind: "visit" }],
    });
    expect(await readFragment(key, "first")).toBeDefined();
    expect(await readProgress(key)).toMatchObject({ last: { blockId: "p" } });
    expect(await exportPreviousEdition(key)).toBeUndefined();
  });

  it("migre une base B03 et conserve préférences, catalogue et ressources", async () => {
    const source = book();
    source.fragments[0]!.html = '<p data-block-id="p">Texte.</p>';
    const { key, fragments, resources, manifest } = await seedLegacyEdition(
      source,
      2,
    );

    await updateProgress(key, (current) => ({
      state: {
        ...current,
        observations: { passage: { elapsedMs: 8000, coverage: 1 } },
      },
      summary: { status: "complete", percent: 100, hasLast: false },
    }));
    expect(await readProgress(key)).toMatchObject({
      observations: { passage: { elapsedMs: 8000, coverage: 1 } },
    });
    expect(await listBooks()).toEqual([
      {
        key,
        title: source.title,
        firstFragmentId: "first",
        resourceBytes: 3,
        progress: { status: "complete", percent: 100, hasLast: false },
      },
    ]);
    expect(await readFontSize()).toBe("small");
    expect(await readManifest(key)).toEqual(manifest);
    expect(await readFragment(key, "first")).toEqual(fragments[0]);
    expect(await readReadingIndex(key, manifest)).toMatchObject({
      fragments: { first: [{ id: "p", weight: 6 }] },
    });
    const [resource] = await readResources(key, ["image"]);
    expect(resource).toMatchObject({ id: "image", mimeType: "image/png" });
    expect(Array.from(resource!.bytes)).toEqual(
      Array.from(resources[0]!.bytes),
    );
  });

  it("applique deux mutations concurrentes à l’état le plus récent de la même édition", async () => {
    const { key } = await saveEdition(book());
    const other = await saveEdition(book("édition indépendante"));
    const changes = await Promise.all(
      ["one", "two"].map((id) =>
        updateProgress(key, (current) => ({
          state: {
            ...current,
            observations: {
              ...current.observations,
              [id]: { elapsedMs: 500, coverage: 0.4 },
            },
          },
        })),
      ),
    );
    expect(
      changes.map((result) => Object.keys(result.observations).length).sort(),
    ).toEqual([1, 2]);
    expect(await readProgress(key)).toMatchObject({
      observations: {
        one: { elapsedMs: 500, coverage: 0.4 },
        two: { elapsedMs: 500, coverage: 0.4 },
      },
    });
    expect(await readProgress(other.key)).toMatchObject({
      observations: {},
      modes: {},
    });
  });

  it("ne crée ni ouvrage ni progression pour une édition absente", async () => {
    const change = vi.fn((state: Awaited<ReturnType<typeof readProgress>>) => ({
      state,
    }));
    await expect(updateProgress("absent", change)).rejects.toThrow(
      "Ouvrage introuvable",
    );
    expect(change).not.toHaveBeenCalled();
    expect(await listBooks()).toEqual([]);
    expect(await readProgress("absent")).toMatchObject({
      observations: {},
      modes: {},
    });
  });

  it("laisse le résumé en place pour une mutation sans résumé et annule si la mutation échoue", async () => {
    const { key } = await saveEdition(book());
    await updateProgress(key, (state) => ({
      state,
      summary: { status: "unstarted", percent: 0, hasLast: false },
    }));
    const expected = await updateProgress(key, (state, summary) => {
      expect(summary).toEqual({
        status: "unstarted",
        percent: 0,
        hasLast: false,
      });
      return { state };
    });
    await expect(
      updateProgress(key, () => {
        throw new Error("Mutation invalide");
      }),
    ).rejects.toThrow("Mutation invalide");
    expect(await readProgress(key)).toEqual(expected);
    expect(await listBooks()).toMatchObject([
      { key, progress: { status: "unstarted", percent: 0, hasLast: false } },
    ]);
  });

  it("annule aussi la progression si l’écriture du résumé au catalogue échoue", async () => {
    const entry = await saveEdition(book());
    const put = IDBObjectStore.prototype.put;
    const quota = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === "catalog")
          throw new DOMException("Quota", "QuotaExceededError");
        return put.call(this, value, key);
      });
    try {
      await expect(
        updateProgress(entry.key, (current) => ({
          state: {
            ...current,
            observations: { passage: { elapsedMs: 1000, coverage: 0.5 } },
          },
          summary: { status: "partial", percent: 50, hasLast: false },
        })),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      expect(await readProgress(entry.key)).toMatchObject({ observations: {} });
      expect(await listBooks()).toEqual([entry]);
    } finally {
      quota.mockRestore();
    }
    await expect(
      readProgress(entry.key, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ajoute les préférences sans altérer une édition écrite par B02", async () => {
    const source = book();
    const { key, fragments, resources, manifest } = await seedLegacyEdition(
      source,
      1,
    );
    expect(await readFontSize()).toBe("medium");
    await saveFontSize("large");
    expect(await readFontSize()).toBe("large");
    expect(await listBooks()).toMatchObject([{ key, title: source.title }]);
    expect(await readManifest(key)).toEqual(manifest);
    expect(await readFragment(key, "first")).toEqual(fragments[0]);
    const [resource] = await readResources(key, ["image"]);
    expect(resource).toMatchObject({ id: "image", mimeType: "image/png" });
    expect(Array.from(resource!.bytes)).toEqual(
      Array.from(resources[0]!.bytes),
    );
  });

  it("retrouve le catalogue, le manifeste, un fragment et ses ressources après réouverture", async () => {
    const source = book();
    const entry = await saveEdition(source);
    expect(await listBooks()).toEqual([entry]);
    expect(entry).toMatchObject({
      title: source.title,
      firstFragmentId: "first",
      resourceBytes: 3,
    });
    expect(await readManifest(entry.key)).toMatchObject({
      destinations: source.destinations,
    });
    expect(await readFragment(entry.key, "first")).toEqual(source.fragments[0]);
    const [resource] = await readResources(entry.key, ["image"]);
    expect(resource).toMatchObject({ id: "image", mimeType: "image/png" });
    expect(Array.from(resource!.bytes)).toEqual([1, 2, 3]);
    expect(await readFragment(entry.key, "absent")).toBeUndefined();
  });

  it("réimporte une édition identique sans créer de doublon", async () => {
    const source = book();
    expect(await saveEdition(source)).toEqual(await saveEdition(source));
    expect(await listBooks()).toHaveLength(1);
  });

  it("annule la transaction complète lorsqu’une écriture échoue", async () => {
    const previous = await saveEdition(book());
    const duplicate = book("edition-2");
    duplicate.resources.push(duplicate.resources[0]!);
    await expect(saveEdition(duplicate)).rejects.toMatchObject({
      name: "ConstraintError",
    });
    expect(await listBooks()).toEqual([previous]);
    expect(
      await readManifest(JSON.stringify(["work-1", "edition-2"])),
    ).toBeUndefined();
  });

  it("écarte une édition présentant une perte bloquante", async () => {
    const source = book();
    source.diagnostics.push({
      code: "unresolved-link",
      severity: "error",
      count: 1,
    });
    await expect(saveEdition(source)).rejects.toThrow();
    expect(await listBooks()).toEqual([]);
  });

  it("ne publie rien si le signal est déjà annulé", async () => {
    await expect(
      saveEdition(book(), AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await listBooks()).toEqual([]);
  });

  it("annule aussi pendant les écritures déjà commencées", async () => {
    const controller = new AbortController();
    const add = IDBObjectStore.prototype.add;
    const cancel = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = add.call(this, value, key);
        if (this.name === "catalog") controller.abort();
        return request;
      });
    try {
      await expect(
        saveEdition(book(), controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await listBooks()).toEqual([]);
    } finally {
      cancel.mockRestore();
    }
  });

  it("ouvre un seul fragment et révoque ses URL d’images lors du changement", async () => {
    const source = book();
    source.fragments[0]!.html =
      '<p>Un texte.</p><img data-resource-id="image" alt="Carte">';
    const entry = await saveEdition(source);
    const container = document.createElement("article");
    const preview = createFragmentRenderer(container);
    const create = vi.fn().mockReturnValue("blob:resource");
    const revoke = vi.fn();
    class TestUrl extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    }
    vi.stubGlobal("URL", TestUrl);
    try {
      await preview.open(entry.key, entry.firstFragmentId);
      expect(container.querySelector("img")?.src).toBe("blob:resource");
      expect(container.textContent).toBe("Un texte.");
      container.querySelector("img")?.dispatchEvent(new Event("error"));
      expect(container.textContent).toContain("Image indisponible · Carte");
      await preview.open(entry.key, undefined);
      expect(revoke).toHaveBeenCalledWith("blob:resource");
      expect(container.textContent).toBe("");
      await expect(preview.open(entry.key, "missing")).rejects.toThrow(
        "Fragment introuvable",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("une ouverture plus récente prévaut et une image absente ne déclenche aucune URL", async () => {
    const source = book();
    source.fragments[0]!.resourceIds = ["absent"];
    source.fragments[0]!.html =
      '<p>Texte ancien.</p><img data-resource-id="absent">';
    const first = await saveEdition(source);
    const second = await saveEdition(book("édition suivante"));
    const container = document.createElement("article");
    const preview = createFragmentRenderer(container);
    const create = vi.fn().mockReturnValue("blob:resource");
    class TestUrl extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestUrl);
    try {
      await preview.open(first.key, first.firstFragmentId);
      expect(container.textContent).toContain("Image indisponible.");
      expect(create).not.toHaveBeenCalled();
      await Promise.all([
        preview.open(first.key, first.firstFragmentId),
        preview.open(second.key, second.firstFragmentId),
      ]);
      expect(container.textContent).toBe("Texte.");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("restauration de sauvegarde", () => {
  beforeEach(resetDatabase);

  const source = {
    ...book(),
    fragments: [
      { ...book().fragments[0]!, html: '<p data-block-id="p">Texte.</p>' },
    ],
  };
  const key = JSON.stringify([source.workId, source.editionId]);
  const event: ProgressEvent = {
    kind: "observe",
    deviceId: "ancien-appareil",
    clock: 4,
    samples: [{ unitId: "p", elapsedMs: 4000, coverage: 15 }],
  };
  const snapshot = {
    book: source,
    progress: {
      observations: { p: { elapsedMs: 4000, coverage: 15 } },
      modes: {},
    },
    events: [event],
  };

  it("restaure ouvrage, suivi et événements avec leurs identités", async () => {
    await saveFontSize("small");
    await restoreBookBackup(snapshot);
    const restored = await exportBookBackup(key);
    expect({ ...restored, book: plainEdition(restored.book) }).toEqual({
      ...snapshot,
      book: plainEdition(source),
    });
    expect(await readFontSize()).toBe("small");
    const index = await readReadingIndex(key, (await readManifest(key))!);
    expect(await applyRemoteProgress(key, index, [event])).toEqual(
      snapshot.progress,
    );
    const position = { fragmentId: "first", blockId: "p" };
    await updateProgress(key, (state) => ({
      state: { ...state, last: position },
      events: [{ kind: "visit", position }],
    }));
    expect((await readProgressJournal(key))?.events).toMatchObject([
      { clock: 5, position },
    ]);
  });

  it("refuse un ouvrage présent, même dans une autre édition", async () => {
    const existing = await saveEdition(book("autre-édition"));
    await expect(restoreBookBackup(snapshot)).rejects.toMatchObject({
      name: "BackupAlreadyPresentError",
    });
    expect(await listBooks()).toEqual([existing]);
  });

  it("refuse une projection incompatible et annule une écriture interrompue", async () => {
    await expect(
      restoreBookBackup({
        ...snapshot,
        progress: { observations: {}, modes: {} },
      }),
    ).rejects.toThrow();
    const abort = new AbortController();
    const add = IDBObjectStore.prototype.add;
    const probe = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        storageKey?: IDBValidKey,
      ) {
        if (this.name === "catalog") abort.abort();
        return add.call(this, value, storageKey);
      });
    try {
      await expect(
        restoreBookBackup(snapshot, abort.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      probe.mockRestore();
    }
    expect(await listBooks()).toEqual([]);
    expect(await readManifest(key)).toBeUndefined();
    expect(await readFragment(key, "first")).toBeUndefined();
    expect(await readProgressJournal(key)).toBeUndefined();
  });
});

describe("remplacement d’édition", () => {
  beforeEach(resetDatabase);

  const previousBook = {
    ...book(),
    fragments: [
      { ...book().fragments[0]!, html: '<p data-block-id="p">Texte.</p>' },
    ],
  };
  const replacement = {
    ...previousBook,
    title: "Nouvelle édition",
    fragments: [
      {
        ...previousBook.fragments[0]!,
        html: '<div><p data-block-id="p">Texte.</p></div>',
      },
    ],
  };

  async function prepare() {
    const entry = await saveEdition(previousBook);
    const index = await readReadingIndex(
      entry.key,
      (await readManifest(entry.key))!,
    );
    await updateProgress(entry.key, (state) => ({
      state: changeMode(index, state, "section", "read"),
      events: [{ kind: "mode", scopeId: "section", mode: "read" }],
    }));
    return entry;
  }

  it("ne crée aucune révision quand la source et son rendu sont déjà installés", async () => {
    const { key } = await prepare();
    expect(
      await replaceEdition(key, { ...previousBook, title: "Fichier renommé" }),
    ).toEqual({ key, omitted: 0, replaced: false });
    expect(await exportPreviousEdition(key)).toBeUndefined();
    expect(await readProgress(key)).toMatchObject({
      modes: { section: "read" },
    });
  });

  it("reconnaît la même source après le tri des métadonnées dans une sauvegarde", async () => {
    const z = { fragmentId: "first", elementId: "blacture-anchor-z" };
    const a = { fragmentId: "first", elementId: "blacture-anchor-a" };
    const diagnostics = [
      { code: "z", count: 1, severity: "warning" as const },
      { code: "a", count: 1, severity: "warning" as const },
    ];
    const { key } = await saveEdition({
      ...previousBook,
      destinations: { a, z },
      diagnostics: [...diagnostics].reverse(),
    });
    expect(
      await replaceEdition(key, {
        ...previousBook,
        destinations: { z, a },
        diagnostics,
      }),
    ).toEqual({ key, omitted: 0, replaced: false });
  });

  it("publie une seule édition et sauvegarde l’original avec son journal", async () => {
    const { key } = await prepare();
    await bindDriveAccount("compte-synthétique");
    await trackDriveEdition("compte-synthétique", key);
    const result = await replaceEdition(key, replacement);
    expect(result.key).not.toBe(key);
    expect(await readManifest(key)).toBeUndefined();
    expect(await readProgress(result.key)).toMatchObject({
      modes: { section: "read" },
    });
    expect(await saveEdition(replacement)).toMatchObject({ key: result.key });
    expect(await listBooks()).toEqual([
      expect.objectContaining({ key: result.key, title: previousBook.title }),
    ]);
    expect(await readDriveSelections("compte-synthétique")).toEqual([]);
    const archived = await exportPreviousEdition(result.key);
    expect(archived).toMatchObject({
      book: { title: previousBook.title },
      progress: { modes: { section: "read" } },
      events: [{ kind: "mode", scopeId: "section", mode: "read" }],
    });
  });

  it("conserve l’édition et la progression si la publication échoue", async () => {
    const { key } = await prepare();
    const add = IDBObjectStore.prototype.add;
    const probe = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        storageKey?: IDBValidKey,
      ) {
        if (this.name === "catalog")
          throw new DOMException("Disque plein", "QuotaExceededError");
        return add.call(this, value, storageKey);
      });
    try {
      await expect(replaceEdition(key, replacement)).rejects.toMatchObject({
        name: "QuotaExceededError",
      });
    } finally {
      probe.mockRestore();
    }
    expect(await listBooks()).toEqual([
      expect.objectContaining({ key, title: previousBook.title }),
    ]);
    expect(await readProgress(key)).toMatchObject({
      modes: { section: "read" },
    });
    expect(await exportPreviousEdition(key)).toBeUndefined();
  });

  it("retire la copie active pour permettre la restauration locale sans réactiver Drive", async () => {
    const { key } = await prepare();
    await bindDriveAccount("compte-synthétique");
    await trackDriveEdition("compte-synthétique", key);
    const result = await replaceEdition(key, replacement);
    await trackDriveEdition("compte-synthétique", result.key);
    const previous = (await exportPreviousEdition(result.key))!;
    await removeLocalEdition(result.key);
    expect(await listBooks()).toEqual([]);
    expect(await exportPreviousEdition(result.key)).toBeUndefined();
    expect(await readResources(result.key, ["image"])).toEqual([]);
    await restoreBookBackup(previous);
    expect(await readDriveBinding()).toBe("compte-synthétique");
    expect(await readDriveSelections("compte-synthétique")).toEqual([]);
    expect(await readProgress(key)).toMatchObject({
      modes: { section: "read" },
    });
  });

  it("refuse le curseur d’un envoi commencé avant le retrait de l’ouvrage", async () => {
    const { key } = await prepare();
    await bindDriveAccount("compte-synthétique");
    const old = (await readProgressJournal(key))!;
    await removeLocalEdition(key);
    await saveEdition(previousBook);
    await ensureProgressJournal(key);
    const current = (await readProgressJournal(key))!;
    const pending = { sentThrough: 0, pendingThrough: 1 };
    await expect(
      writeDriveProgressCursor("compte-synthétique", key, pending, {
        key,
        deviceId: old.deviceId,
      }),
    ).rejects.toThrow(/journal/u);
    expect(await readDriveProgressCursor("compte-synthétique", key)).toEqual({
      sentThrough: 0,
    });
    await writeDriveProgressCursor("compte-synthétique", key, pending, {
      key,
      deviceId: current.deviceId,
    });
    expect(await readDriveProgressCursor("compte-synthétique", key)).toEqual(
      pending,
    );
  });

  it("conserve l’empreinte de la source à travers une sauvegarde de l’édition corrigée", async () => {
    const { key } = await prepare();
    const result = await replaceEdition(key, replacement);
    const archive = await exportBookBackup(result.key);
    await resetDatabase();
    await restoreBookBackup(archive);
    expect((await saveEdition(replacement)).key).toBe(result.key);
    expect(await listBooks()).toHaveLength(1);

    await resetDatabase();
    const separate = await saveEdition({
      ...replacement,
      workId: "autre-ouvrage",
    });
    await expect(restoreBookBackup(archive)).rejects.toMatchObject({
      name: "BackupAlreadyPresentError",
    });
    expect(await listBooks()).toEqual([separate]);
  });

  it("retrouve la même révision quand les deux appareils remplacent la même source", async () => {
    const first = await prepare();
    const revision = await replaceEdition(first.key, replacement);
    await resetDatabase();
    const second = await prepare();
    expect(
      await replaceEdition(second.key, {
        ...replacement,
        title: "Nouvelle édition (1)",
      }),
    ).toEqual(revision);
    expect(await replaceEdition(revision.key, replacement)).toEqual({
      ...revision,
      replaced: false,
    });
    expect(await exportPreviousEdition(revision.key)).toMatchObject({
      book: { title: previousBook.title },
    });
  });
});

describe("journal local de progression", () => {
  beforeEach(resetDatabase);

  it("migre la base B04 puis initialise les acquis, corrections imbriquées et position une seule fois", async () => {
    const source = book();
    source.sections.push({
      id: "child",
      title: "Sous-section",
      parentId: "section",
      level: 2,
      fragmentIds: [],
    });
    const { key, manifest, fragments } = await seedLegacyEdition(source, 3);
    const previous = await readProgress(key);
    expect(await readProgressJournal(key)).toBeUndefined();
    await Promise.all([ensureProgressJournal(key), ensureProgressJournal(key)]);
    expect(await readFontSize()).toBe("small");
    expect(await readFragment(key, "first")).toEqual(fragments[0]);
    expect(await readReadingIndex(key, manifest)).toMatchObject({
      fragments: { first: [{ id: "p", weight: 6 }] },
    });
    expect(await readProgress(key)).toEqual(previous);
    const journal = await readProgressJournal(key);
    expect(journal?.deviceId).toBeTruthy();
    expect(journal?.events).toEqual(
      [
        {
          kind: "observe",
          samples: [{ unitId: "p", elapsedMs: 4000, coverage: 3 }],
        },
        { kind: "mode", scopeId: BOOK_SCOPE, mode: "unread" },
        { kind: "mode", scopeId: "section", mode: "auto" },
        { kind: "mode", scopeId: "child", mode: "read" },
        { kind: "visit", position: { fragmentId: "first", blockId: "p" } },
      ].map((event, offset) => ({
        ...event,
        clock: offset + 1,
        deviceId: journal?.deviceId,
      })),
    );
  });

  it("assemble des événements propres à chaque édition et alloue les horloges de mutations concurrentes", async () => {
    const { key } = await saveEdition(book());
    const other = await saveEdition(book("other"));
    await Promise.all(
      ["alpha", "beta"].map((unitId) =>
        updateProgress(key, (state) => ({
          state: {
            ...state,
            observations: {
              ...state.observations,
              [unitId]: { elapsedMs: 1000, coverage: FULL_COVERAGE },
            },
          },
          events: [
            {
              kind: "observe",
              samples: [{ unitId, elapsedMs: 1000, coverage: FULL_COVERAGE }],
            },
          ],
        })),
      ),
    );
    await updateProgress(key, (state) => ({ state, events: [] }));
    const journal = await readProgressJournal(key);
    expect(journal?.events.map((event) => event.clock)).toEqual([1, 2]);
    expect(
      journal?.events
        .flatMap((event) =>
          event.kind === "observe"
            ? event.samples.map(({ unitId }) => unitId)
            : [],
        )
        .sort(),
    ).toEqual(["alpha", "beta"]);
    expect(Object.keys((await readProgress(key)).observations).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    expect(await readProgressJournal(other.key)).toBeUndefined();
    await ensureProgressJournal(other.key);
    const otherJournal = await readProgressJournal(other.key);
    expect(otherJournal?.events).toEqual([]);
    expect(otherJournal?.deviceId).toBeTruthy();
    expect(otherJournal?.deviceId).not.toBe(journal?.deviceId);
  });

  it("annule événement, état et résumé si la transaction échoue puis reprend à la même horloge", async () => {
    const entry = await saveEdition(book());
    await ensureProgressJournal(entry.key);
    const previous = await readProgress(entry.key);
    const add = IDBObjectStore.prototype.add;
    const fail = vi.spyOn(IDBObjectStore.prototype, "add");
    const write = () =>
      updateProgress(entry.key, (state) => ({
        state: { ...state, last: { fragmentId: "first" } },
        summary: { status: "unstarted", percent: 0, hasLast: true },
        events: [{ kind: "visit", position: { fragmentId: "first" } }],
      }));
    fail.mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "progress-journal-events")
        throw new DOMException("Quota", "QuotaExceededError");
      return add.call(this, value, key);
    });
    try {
      await expect(write()).rejects.toMatchObject({
        name: "QuotaExceededError",
      });
      expect(await readProgress(entry.key)).toEqual(previous);
      expect(await listBooks()).toEqual([entry]);
      expect((await readProgressJournal(entry.key))?.events).toEqual([]);
    } finally {
      fail.mockRestore();
    }
    await write();
    expect((await readProgressJournal(entry.key))?.events).toMatchObject([
      { kind: "visit", clock: 1, position: { fragmentId: "first" } },
    ]);
    expect(await readProgress(entry.key)).toMatchObject({
      last: { fragmentId: "first" },
    });
  });

  it("refuse une opération au-delà de la borne du protocole sans toucher à la progression", async () => {
    const entry = await saveEdition(book());
    await ensureProgressJournal(entry.key);
    const journal = (await readProgressJournal(entry.key))!;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("blacture-library");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("progress-journal-heads", "readwrite");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
        tx.objectStore("progress-journal-heads").put(
          { deviceId: journal.deviceId, clock: maxProgressClock },
          entry.key,
        );
      };
    });
    const position = { fragmentId: "first" };
    await expect(
      updateProgress(entry.key, (state) => ({
        state: { ...state, last: position },
        events: [{ kind: "visit", position }],
      })),
    ).rejects.toThrow("Horloge de progression épuisée.");
    expect(await readProgress(entry.key)).not.toHaveProperty("last");
    expect(await readProgressJournal(entry.key)).toEqual(journal);
  });

  it("initialise de longues observations en lots bornés sans ajouter d’événement aux éditions absentes", async () => {
    const entry = await saveEdition(book());
    await updateProgress(entry.key, (state) => ({
      state: {
        ...state,
        observations: {
          ...Object.fromEntries(
            Array.from({ length: 129 }, (_, id) => [
              `passage-${id}`,
              { elapsedMs: 1000, coverage: 1 },
            ]),
          ),
          recent: { elapsedMs: 100_000, coverage: 15 },
          vacant: { elapsedMs: 0, coverage: 1 },
          zeroCoverage: { elapsedMs: 500, coverage: 0 },
          invalidCoverage: { elapsedMs: 500, coverage: 1.3 },
          unknownCoverage: { elapsedMs: 500, coverage: 16 },
          infinite: { elapsedMs: Infinity, coverage: 1 },
        },
      },
    }));
    await ensureProgressJournal(entry.key);
    const journal = await readProgressJournal(entry.key);
    expect(
      journal?.events.map((event) =>
        event.kind === "observe" ? event.samples.length : 0,
      ),
    ).toEqual([128, 2]);
    expect(journal?.events.at(-1)).toMatchObject({
      samples: expect.arrayContaining([
        { unitId: "recent", elapsedMs: 8000, coverage: 15 },
      ]),
    });
    await expect(ensureProgressJournal("missing")).rejects.toThrow(
      "Ouvrage introuvable.",
    );
    expect(await readProgressJournal("missing")).toBeUndefined();
    await expect(
      readProgressJournal(entry.key, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("application de la progression distante", () => {
  const index: ReadingIndex = {
    sections: [{ id: "section", parentId: null, fragmentIds: ["first"] }],
    fragments: { first: [{ id: "p", weight: 1 }] },
  };
  const receipt: ProgressEvent = {
    deviceId: "un-autre-appareil",
    clock: 12,
    kind: "observe",
    samples: [{ unitId: "p", elapsedMs: 4000, coverage: 12 }],
  };
  beforeEach(resetDatabase);

  it("fusionne l’état, persiste la réception et élève l’horloge sans renvoyer les événements distants", async () => {
    const { key } = await saveEdition(book());
    await updateProgress(key, (state) => ({
      state: observeReading(index, state, "p", 4000, 3),
      events: [
        {
          kind: "observe",
          samples: [{ unitId: "p", elapsedMs: 4000, coverage: 3 }],
        },
      ],
    }));
    const original = (await readProgressJournal(key))!;
    const merged = await applyRemoteProgress(key, index, [
      ...original.events,
      receipt,
      receipt,
    ]);
    expect(merged.observations.p).toEqual({
      elapsedMs: 8000,
      coverage: FULL_COVERAGE,
    });
    expect(await readProgress(key)).toEqual(merged);
    expect(await listBooks()).toMatchObject([
      { key, progress: { status: "complete", percent: 100, hasLast: false } },
    ]);
    expect(await readProgressJournal(key)).toEqual(original);
    expect(await applyRemoteProgress(key, index, [])).toEqual(merged);
    await updateProgress(key, (state) => ({
      state: changeMode(index, state, BOOK_SCOPE, "unread"),
      events: [{ kind: "mode", scopeId: BOOK_SCOPE, mode: "unread" }],
    }));
    expect(
      (await readProgressJournal(key))?.events.map(({ clock }) => clock),
    ).toEqual([1, 13]);
    expect((await applyRemoteProgress(key, index, [receipt])).modes).toEqual({
      [BOOK_SCOPE]: "unread",
    });
  });

  it("refuse une collision de charge utile et un écho inconnu sans modifier l’état", async () => {
    const { key } = await saveEdition(book());
    await expect(applyRemoteProgress(key, index, [receipt])).rejects.toThrow(
      "Journal de progression introuvable.",
    );
    await ensureProgressJournal(key);
    const previous = await applyRemoteProgress(key, index, [receipt]);
    const journal = (await readProgressJournal(key))!;
    const other: ProgressEvent = {
      ...receipt,
      deviceId: "troisieme",
      clock: 14,
    };
    await expect(
      applyRemoteProgress(key, index, [
        other,
        {
          ...receipt,
          samples: [{ unitId: "p", elapsedMs: 1000, coverage: 1 }],
        },
      ]),
    ).rejects.toThrow("Événements incompatibles");
    await expect(
      applyRemoteProgress(key, index, [
        { ...receipt, deviceId: journal.deviceId },
      ]),
    ).rejects.toThrow("Événement local inconnu.");
    await expect(
      applyRemoteProgress(key, index, [
        { ...receipt, clock: maxProgressClock },
      ]),
    ).rejects.toThrow("Horloge de progression distante hors limites.");
    expect(await readProgress(key)).toEqual(previous);
    expect(await applyRemoteProgress(key, index, [])).toEqual(previous);
  });

  it("rejette un compteur distant proche de la borne fil et permet une écriture locale ensuite", async () => {
    const { key } = await saveEdition(book());
    await ensureProgressJournal(key);
    const before = await readProgress(key);
    await expect(
      applyRemoteProgress(key, index, [
        receipt,
        { ...receipt, clock: maxProgressClock - 1 },
      ]),
    ).rejects.toThrow("Horloge de progression distante hors limites.");
    expect(await readProgress(key)).toEqual(before);
    expect(await applyRemoteProgress(key, index, [])).toEqual(before);

    const position = { fragmentId: "first" };
    await updateProgress(key, (state) => ({
      state: { ...state, last: position },
      events: [{ kind: "visit", position }],
    }));
    expect(await readProgress(key)).toMatchObject({ last: position });
    expect((await readProgressJournal(key))?.events).toMatchObject([
      { clock: 1, kind: "visit", position },
    ]);
  });

  it("annule pendant l’enregistrement d’un événement distant puis autorise le rejeu", async () => {
    const { key } = await saveEdition(book());
    await ensureProgressJournal(key);
    const before = await readProgress(key);
    const beforeCatalog = await listBooks();
    const controller = new AbortController();
    const add = IDBObjectStore.prototype.add;
    const cancel = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const request = add.call(this, value, key);
        if (this.name === "progress-remote-events") controller.abort();
        return request;
      });
    try {
      await expect(
        applyRemoteProgress(key, index, [receipt], controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await readProgress(key)).toEqual(before);
      expect(await listBooks()).toEqual(beforeCatalog);
    } finally {
      cancel.mockRestore();
    }
    expect(await applyRemoteProgress(key, index, [])).toEqual(before);
    expect(
      (await applyRemoteProgress(key, index, [receipt])).observations.p,
    ).toEqual({ elapsedMs: 4000, coverage: 12 });
  });
});

describe("association et reprise des transferts Drive", () => {
  beforeEach(resetDatabase);

  it("conserve la première association lorsque deux comptes sont proposés concurremment", async () => {
    expect(await readDriveBinding()).toBeUndefined();
    await expect(bindDriveAccount(" ")).rejects.toThrow(
      "Compte Google Drive invalide.",
    );
    const accounts = ["compte-a", "compte-b"];
    const result = await Promise.allSettled(accounts.map(bindDriveAccount));
    expect(result.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const bound =
      accounts[result.findIndex(({ status }) => status === "fulfilled")]!;
    expect(await readDriveBinding()).toBe(bound);
    await bindDriveAccount(bound);
    expect(await readDriveBinding()).toBe(bound);
  });

  it("vérifie la liaison à chaque accès au ticket et protège la réservation et la confirmation", async () => {
    const key = "package:1";
    const ticket = {
      id: "drive-id",
      finished: false,
      location: "https://example.test/reprise",
    };
    await expect(readDriveTicket("compte-a", key)).rejects.toThrow(
      "Compte Google Drive différent",
    );
    await bindDriveAccount("compte-a");
    expect(await readDriveTicket("compte-a", key)).toBeUndefined();
    await writeDriveTicket("compte-a", key, ticket);
    expect(await readDriveTicket("compte-a", key)).toEqual(ticket);
    await expect(writeDriveTicket("compte-b", key, ticket)).rejects.toThrow(
      "Compte Google Drive différent",
    );
    await expect(
      writeDriveTicket("compte-a", key, { ...ticket, id: "autre-id" }),
    ).rejects.toThrow("Transfert Google Drive déjà réservé.");
    await writeDriveTicket("compte-a", key, { id: ticket.id, finished: true });
    await writeDriveTicket("compte-a", key, ticket);
    expect(await readDriveTicket("compte-a", key)).toEqual({
      id: ticket.id,
      finished: true,
    });
  });

  it("garde la borne du lot en attente jusqu’à confirmation, puis reprend après le dernier événement envoyé", async () => {
    await bindDriveAccount("compte-a");
    const key = "edition-a";
    expect(await readDriveProgressCursor("compte-a", key)).toEqual({
      sentThrough: 0,
    });
    const pending = { sentThrough: 0, pendingThrough: 4 };
    await writeDriveProgressCursor("compte-a", key, pending);
    expect(await readDriveProgressCursor("compte-a", key)).toEqual(pending);
    await expect(
      writeDriveProgressCursor("compte-a", key, { sentThrough: 2 }),
    ).rejects.toThrow("Curseur Google Drive obsolète.");
    await expect(
      writeDriveProgressCursor("compte-a", key, {
        sentThrough: 2,
        pendingThrough: 4,
      }),
    ).rejects.toThrow("Curseur Google Drive obsolète.");
    await expect(
      writeDriveProgressCursor("compte-b", key, pending),
    ).rejects.toThrow("Compte Google Drive différent");
    await expect(
      writeDriveProgressCursor("compte-a", key, {
        sentThrough: 4,
        pendingThrough: 4,
      }),
    ).rejects.toThrow("Curseur Google Drive invalide.");
    await writeDriveProgressCursor("compte-a", key, { sentThrough: 4 });
    await expect(
      writeDriveProgressCursor("compte-a", key, { sentThrough: 3 }),
    ).rejects.toThrow("Curseur Google Drive obsolète.");
    expect(await readDriveProgressCursor("compte-a", key)).toEqual({
      sentThrough: 4,
    });
    expect(await readDriveProgressCursor("compte-a", "edition-b")).toEqual({
      sentThrough: 0,
    });
  });

  it("reprend les seules sélections explicites et ne mélange pas celles de comptes différents", async () => {
    await bindDriveAccount("compte-a");
    expect(await readDriveSelections("compte-a")).toEqual([]);
    const entries = await Promise.all([
      saveEdition(book()),
      saveEdition(book("edition-b")),
    ]);
    await Promise.all(
      entries.map(({ key }) => trackDriveEdition("compte-a", key)),
    );
    await trackDriveEdition("compte-a", entries[0]!.key);
    expect((await readDriveSelections("compte-a")).sort()).toEqual(
      entries.map(({ key }) => key).sort(),
    );
    await expect(readDriveSelections("compte-b")).rejects.toThrow(
      "Compte Google Drive différent",
    );
    await expect(trackDriveEdition("compte-b", "intrus")).rejects.toThrow(
      "Compte Google Drive différent",
    );
    expect(await readDriveSelections("compte-a")).not.toContain("intrus");
  });
});

describe("lecture d’une édition complète", () => {
  beforeEach(resetDatabase);

  it("exporte dans l’ordre du manifeste avec les seules ressources référencées de cette édition", async () => {
    const source = book();
    const first = source.fragments[0]!;
    const second = { ...first, id: "second", resourceIds: ["other", "image"] };
    source.sections[0]!.fragmentIds = ["second", "first"];
    source.fragments = [first, second];
    const otherResource = {
      ...source.resources[0]!,
      id: "other",
      bytes: new Uint8Array([4]),
    };
    const unused = { ...otherResource, id: "unused" };
    source.resources.push(otherResource, unused);
    const { key } = await saveEdition(source);
    const foreign = book("foreign");
    foreign.resources[0]!.bytes = new Uint8Array([9]);
    await saveEdition(foreign);

    const exported = await exportEdition(key);
    const expected: ImportedBook = {
      ...source,
      fragments: [second, first],
      resources: [otherResource, source.resources[0]!],
    };
    expect(plainEdition(exported)).toEqual(plainEdition(expected));
    exported.resources[0]!.bytes[0] = 0;
    expect(plainEdition(await exportEdition(key))).toEqual(
      plainEdition(expected),
    );
  });

  it("refuse une édition ou une ressource absente, un manifeste incohérent et une lecture annulée", async () => {
    await expect(exportEdition("absente")).rejects.toThrow(
      "Ouvrage introuvable.",
    );
    const source = book();
    source.fragments[0]!.resourceIds = ["absente"];
    const { key } = await saveEdition(source);
    await expect(exportEdition(key)).rejects.toThrow(
      "Ressource de l’édition introuvable.",
    );
    const inconsistent = book("inconsistent");
    inconsistent.sections[0]!.fragmentIds.push("absent");
    const entry = await saveEdition(inconsistent);
    await expect(exportEdition(entry.key)).rejects.toThrow(
      "Édition incohérente.",
    );
    await expect(
      exportEdition(entry.key, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("instantané local d’un ouvrage", () => {
  beforeEach(resetDatabase);

  it.each([3, 4])(
    "préserve la progression du profil v%i sans initialiser son journal",
    async (version) => {
      const source = book();
      const previous = {
        observations: { p: { elapsedMs: 4000, coverage: 3 } },
        modes: { child: "read", [BOOK_SCOPE]: "unread", section: "auto" },
        last: { fragmentId: "first", blockId: "p" },
      } as const;
      const { key } =
        version === 3
          ? await seedLegacyEdition(source, 3)
          : await saveEdition(source);
      if (version === 4) {
        await saveFontSize("small");
        await updateProgress(key, () => ({ state: previous }));
      }
      const backup = await exportBookBackup(key);
      expect(plainEdition(backup.book)).toEqual(plainEdition(source));
      expect(backup.progress).toEqual(previous);
      expect(backup.events).toEqual([]);
      expect(await readProgressJournal(key)).toBeUndefined();
      expect(await readFontSize()).toBe("small");
    },
  );

  it("inclut les événements locaux et reçus sans données de compte ni autre édition", async () => {
    const source = book();
    const { key } = await saveEdition(source);
    const other = await saveEdition(book("étrangère"));
    await bindDriveAccount("compte-synthétique");
    await trackDriveEdition("compte-synthétique", other.key);
    await saveFontSize("large");

    const index: ReadingIndex = {
      sections: [{ id: "section", parentId: null, fragmentIds: ["first"] }],
      fragments: { first: [{ id: "p", weight: 1 }] },
    };
    await updateProgress(key, (state) => ({
      state: observeReading(index, state, "p", 4000, 3),
      events: [
        {
          kind: "observe",
          samples: [{ unitId: "p", elapsedMs: 4000, coverage: 3 }],
        },
      ],
    }));
    await updateProgress(other.key, (state) => ({
      state: changeMode(index, state, BOOK_SCOPE, "read"),
      events: [{ kind: "mode", scopeId: BOOK_SCOPE, mode: "read" }],
    }));
    const local = (await readProgressJournal(key))!.events;
    const receipt: ProgressEvent = {
      kind: "observe",
      deviceId: "autre-appareil",
      clock: 4,
      samples: [{ unitId: "p", elapsedMs: 4000, coverage: 12 }],
    };
    await applyRemoteProgress(other.key, index, [{ ...receipt, clock: 7 }]);
    const state = await applyRemoteProgress(key, index, [receipt]);
    const backup = await exportBookBackup(key);
    expect({ ...backup, book: plainEdition(backup.book) }).toEqual({
      book: plainEdition(source),
      progress: state,
      events: [...local, receipt],
    });
    expect(await readProgressJournal(other.key)).toMatchObject({
      events: [{ kind: "mode", scopeId: BOOK_SCOPE, mode: "read" }],
    });
  });

  it("lit l’état et les événements cohérents pendant une écriture concurrente", async () => {
    const { key } = await saveEdition(book());
    await ensureProgressJournal(key);
    const getAll = IDBObjectStore.prototype.getAll;
    let writing: Promise<Awaited<ReturnType<typeof readProgress>>> | undefined;
    const position = { fragmentId: "first" };
    const probe = vi
      .spyOn(IDBObjectStore.prototype, "getAll")
      .mockImplementation(function (
        this: IDBObjectStore,
        query?: IDBValidKey | IDBKeyRange | null,
        count?: number,
      ) {
        const request = getAll.call(this, query, count);
        if (this.name === "progress-journal-events" && !writing) {
          writing = updateProgress(key, (state) => ({
            state: { ...state, last: position },
            events: [{ kind: "visit", position }],
          }));
        }
        return request;
      });
    try {
      const backup = await exportBookBackup(key);
      expect(writing).toBeDefined();
      expect(backup.progress.last).toBeUndefined();
      expect(backup.events).toEqual([]);
    } finally {
      probe.mockRestore();
      await writing;
    }
    expect(await readProgress(key)).toMatchObject({ last: position });
    expect((await readProgressJournal(key))?.events).toMatchObject([
      { kind: "visit", position },
    ]);
  });

  it("annule la lecture sans produire d’instantané partiel ni créer de journal", async () => {
    const { key } = await saveEdition(book());
    const controller = new AbortController();
    const get = IDBObjectStore.prototype.get;
    const probe = vi
      .spyOn(IDBObjectStore.prototype, "get")
      .mockImplementation(function (
        this: IDBObjectStore,
        query: IDBValidKey | IDBKeyRange,
      ) {
        const request = get.call(this, query);
        if (this.name === "resources") controller.abort();
        return request;
      });
    try {
      await expect(
        exportBookBackup(key, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      probe.mockRestore();
    }
    expect(await readProgressJournal(key)).toBeUndefined();
    await expect(exportBookBackup("absente")).rejects.toThrow(
      "Ouvrage introuvable.",
    );
  });
});
