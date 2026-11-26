import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedBook } from "../src/import";
import { createFragmentRenderer } from "../src/fragment-preview";
import {
  listBooks,
  readFontSize,
  readFragment,
  readManifest,
  readResources,
  saveEdition,
  saveFontSize,
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

async function resetDatabase() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("blacture-library");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("publication atomique d’une édition", () => {
  beforeEach(resetDatabase);

  it("ajoute les préférences en v2 sans altérer une édition écrite par B02", async () => {
    const source = book();
    const key = JSON.stringify([source.workId, source.editionId]);
    const { fragments, resources, ...manifest } = source;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("blacture-library", 1);
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
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
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
