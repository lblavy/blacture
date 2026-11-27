import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedBook } from "../src/import";
import { startReader } from "../src/reader";
import * as readingObserver from "../src/reader/reading-observer";
import * as storage from "../src/storage";
import { readFontSize, saveEdition, saveFontSize } from "../src/storage";

function makeControls() {
  const library = document.createElement("main");
  const panel = document.createElement("section");
  const heading = document.createElement("h1");
  const contents = document.createElement("article");
  const outline = document.createElement("nav");
  const outlinePanel = document.createElement("details");
  const fontSize = document.createElement("select");
  for (const size of ["small", "medium", "large"])
    fontSize.add(new Option(size, size));
  const previous = document.createElement("button");
  const next = document.createElement("button");
  const returnToLibrary = document.createElement("button");
  const returnToReference = document.createElement("button");
  const status = document.createElement("output");
  const progress = {
    contents,
    toolbar: document.createElement("header"),
    bookState: document.createElement("output"),
    sectionState: document.createElement("output"),
    bookMode: document.createElement("select"),
    sectionMode: document.createElement("select"),
    error: document.createElement("output"),
  };
  outlinePanel.append(outline);
  panel.append(
    heading,
    contents,
    outlinePanel,
    fontSize,
    previous,
    next,
    returnToLibrary,
    returnToReference,
    status,
    ...Object.values(progress).filter((element) => element !== contents),
  );
  document.body.append(library, panel);
  return {
    library,
    panel,
    heading,
    contents,
    outline,
    outlinePanel,
    fontSize,
    previous,
    next,
    returnToLibrary,
    returnToReference,
    status,
    progress,
  };
}

function sample(title = "Livre témoin"): ImportedBook {
  return {
    schemaVersion: 1,
    workId: title,
    editionId: "edition-local",
    title,
    sections: [
      {
        id: "parent",
        parentId: null,
        title: "Parent",
        level: 1,
        fragmentIds: ["parent-a", "parent-b"],
      },
      {
        id: "child",
        parentId: "parent",
        title: "Même titre",
        level: 3,
        fragmentIds: ["child-a"],
      },
      {
        id: "sibling",
        parentId: null,
        title: "Même titre",
        level: 1,
        fragmentIds: ["sibling-a"],
      },
    ],
    fragments: [
      {
        id: "parent-a",
        sectionId: "parent",
        html: '<p>Contenu propre. 中文 <a data-target-anchor="note">Note</a><a data-target-anchor="local">Dans le fragment</a></p><details><summary>Détail</summary><p id="blacture-anchor-local">Cible locale.</p></details><img data-resource-id="present" alt="Oiseau">',
        blockIds: [],
        resourceIds: ["present"],
      },
      {
        id: "parent-b",
        sectionId: "parent",
        html: "<p>Suite du parent.</p>",
        blockIds: [],
        resourceIds: [],
      },
      {
        id: "child-a",
        sectionId: "child",
        html: '<p><a id="blacture-anchor-note"></a>Texte de la note.</p>',
        blockIds: [],
        resourceIds: [],
      },
      {
        id: "sibling-a",
        sectionId: "sibling",
        html: '<p>Autre section.</p><img data-resource-id="elsewhere" alt="Pierre">',
        blockIds: [],
        resourceIds: ["elsewhere"],
      },
    ],
    destinations: {
      note: { elementId: "blacture-anchor-note", fragmentId: "child-a" },
      local: { elementId: "blacture-anchor-local", fragmentId: "parent-a" },
    },
    resources: [
      { id: "present", mimeType: "image/png", bytes: new Uint8Array([1, 2]) },
      {
        id: "elsewhere",
        mimeType: "image/webp",
        bytes: new Uint8Array([3, 4]),
      },
    ],
    diagnostics: [],
  };
}

async function reset() {
  history.replaceState(null, "", location.pathname + location.search);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("blacture-library");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function stubBlobUrls() {
  const create = vi.fn().mockReturnValue("blob:local-image");
  const revoke = vi.fn();
  class ReaderUrl extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  }
  vi.stubGlobal("URL", ReaderUrl);
  return { create, revoke };
}

describe("lecteur local", () => {
  let reader: ReturnType<typeof startReader> | undefined;
  beforeEach(reset);
  afterEach(() => {
    reader?.dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("does not replace a newer reading choice when an earlier resume finishes late", async () => {
    stubBlobUrls();
    const older = await saveEdition(sample("Ancien ouvrage"));
    const newer = await saveEdition(sample("Nouvel ouvrage"));
    const controls = makeControls();
    reader = startReader(controls);
    type State = Awaited<ReturnType<typeof storage.readProgress>>;
    let finishReading!: (state: State) => void;
    const pending = new Promise<State>((resolve) => {
      finishReading = resolve;
    });
    const read = vi.spyOn(storage, "readProgress").mockReturnValueOnce(pending);
    try {
      const obsolete = reader.resume(older, "last");
      await vi.waitFor(() => expect(read.mock.calls[0]?.[0]).toBe(older.key));
      await reader.open(newer);
      finishReading({
        observations: {},
        modes: {},
        last: { fragmentId: "parent-a" },
      });
      await obsolete;
      expect(controls.heading.textContent).toBe(newer.title);
    } finally {
      read.mockRestore();
    }
  });

  it("charge un fragment, affiche le sommaire paresseusement et suit l’ordre canonique", async () => {
    const urls = stubBlobUrls();
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    expect(controls.panel.hidden).toBe(false);
    expect(controls.library.hidden).toBe(true);
    expect(controls.heading.textContent).toBe(entry.title);
    expect(controls.contents.textContent).toContain("Contenu propre. 中文");
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(controls.previous.disabled).toBe(true);
    expect(controls.next.disabled).toBe(false);
    const branch = controls.outline.querySelector("details")!;
    expect(branch.querySelectorAll("button")).toHaveLength(0);
    branch.open = true;
    branch.dispatchEvent(new Event("toggle"));
    expect(branch.querySelector("button")?.textContent).toBe("Même titre");

    controls.next.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Suite du parent."),
    );
    expect(urls.revoke).toHaveBeenCalledTimes(1);
    controls.next.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Texte de la note."),
    );
    controls.next.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Autre section."),
    );
    expect(controls.next.disabled).toBe(true);
    expect(urls.create).toHaveBeenCalledTimes(2);
  });

  it("donne la priorité à l’ouverture la plus récente", async () => {
    const urls = stubBlobUrls();
    const first = await saveEdition(sample("Premier ouvrage"));
    const second = await saveEdition(sample("Second ouvrage"));
    const controls = makeControls();
    reader = startReader(controls);
    await Promise.all([reader.open(first), reader.open(second)]);
    expect(controls.heading.textContent).toBe("Second ouvrage");
    expect(controls.contents.textContent).toContain("Contenu propre.");
    expect(urls.create).toHaveBeenCalledTimes(1);
  });

  it("passe aux entrées récentes et précédentes de l’historique sans perdre les fragments", async () => {
    stubBlobUrls();
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    controls.next.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Suite du parent."),
    );
    history.back();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Contenu propre."),
    );
    history.forward();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Suite du parent."),
    );
  });

  it("rétablit le retour explicite après reconstruction du lecteur sur la même entrée", async () => {
    stubBlobUrls();
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    controls.contents
      .querySelector<HTMLAnchorElement>("a[data-target-anchor=note]")!
      .click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Texte de la note."),
    );
    reader.dispose();
    document.body.replaceChildren();
    const reloaded = makeControls();
    reader = startReader(reloaded);
    await vi.waitFor(() =>
      expect(reloaded.returnToReference.hidden).toBe(false),
    );
    reloaded.returnToReference.click();
    await vi.waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Note"),
    );
  });

  it("signale un ouvrage ou un fragment manquant et permet de revenir à la bibliothèque", async () => {
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open({ ...entry, key: "import-inexistant" });
    expect(controls.status.textContent).toContain("Ouvrage indisponible");
    await reader.open({ ...entry, firstFragmentId: "fragment-inexistant" });
    expect(controls.status.textContent).toContain("Fragment indisponible");
    expect(controls.previous.disabled).toBe(true);
    expect(controls.next.disabled).toBe(true);
    controls.returnToLibrary.click();
    expect(controls.library.hidden).toBe(false);
  });

  it("révèle et marque la section courante lorsque le sommaire est ouvert", async () => {
    stubBlobUrls();
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open({ ...entry, firstFragmentId: "child-a" });
    expect(controls.outline.querySelector("[aria-current]")).toBeNull();
    controls.outlinePanel.open = true;
    controls.outlinePanel.dispatchEvent(new Event("toggle"));
    const branch = controls.outline.querySelector("details")!;
    expect(branch.open).toBe(true);
    expect(branch.querySelector("button")?.getAttribute("aria-current")).toBe(
      "location",
    );
    controls.outline.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Contenu propre."),
    );
    expect(branch.querySelector("[aria-current]")).toBeNull();
  });

  it("garde les liens externes sans href et ouvre seulement celui explicitement activé", async () => {
    const fixture = sample();
    fixture.fragments[1]!.html = `<a data-external-url="https://example.com/notice">Notice</a><a data-external-url="${location.origin}/">Application</a><a data-external-url="./fichier">Relatif</a><a data-target-anchor="constructor">Renvoi absent</a>`;
    const entry = await saveEdition(fixture);
    const controls = makeControls();
    const openWindow = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      reader = startReader(controls);
      await reader.open({ ...entry, firstFragmentId: "parent-b" });
      expect(controls.contents.querySelectorAll("[href]")).toHaveLength(0);
      expect(openWindow).not.toHaveBeenCalled();
      const links = controls.contents.querySelectorAll("a");
      links[1]!.click();
      links[2]!.click();
      links[3]!.click();
      expect(controls.status.textContent).toBe("Renvoi indisponible.");
      expect(openWindow).not.toHaveBeenCalled();
      links[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      expect(openWindow).toHaveBeenCalledExactlyOnceWith(
        "https://example.com/notice",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      openWindow.mockRestore();
    }
  });

  it("suit un renvoi interfragment et revient à l’appel exact au clavier", async () => {
    stubBlobUrls();
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    const call = controls.contents.querySelector<HTMLAnchorElement>(
      "a[data-target-anchor=note]",
    )!;
    expect(call.getAttribute("href")).toContain("#lecture?");
    call.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Texte de la note."),
    );
    expect(document.activeElement?.id).toBe("blacture-anchor-note");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    expect(controls.returnToReference.hidden).toBe(false);
    controls.returnToReference.click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Contenu propre."),
    );
    expect(document.activeElement?.textContent).toBe("Note");
    expect(controls.returnToReference.hidden).toBe(true);
  });

  it("referme le retour local quand le lien éditorial vise le sup de l’appel", async () => {
    stubBlobUrls();
    const fixture = sample();
    fixture.fragments[0]!.html =
      '<p>Passage <sup id="blacture-anchor-appel"><a data-target-anchor="note">Appel</a></sup></p>';
    fixture.fragments[2]!.html +=
      '<a data-target-anchor="appel">Retour éditorial</a>';
    fixture.destinations.appel = {
      fragmentId: "parent-a",
      elementId: "blacture-anchor-appel",
    };
    const entry = await saveEdition(fixture);
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    controls.contents
      .querySelector<HTMLAnchorElement>("a[data-target-anchor=note]")!
      .click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Texte de la note."),
    );
    controls.contents
      .querySelector<HTMLAnchorElement>("a[data-target-anchor=appel]")!
      .click();
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toBe("Passage Appel"),
    );
    expect(controls.returnToReference.hidden).toBe(true);
    expect(document.activeElement?.textContent).toBe("Appel");
  });

  it("conserve le retour au passage quand le fragment d’un renvoi est absent", async () => {
    stubBlobUrls();
    const fixture = sample();
    fixture.destinations.note!.fragmentId = "fragment-absent";
    const entry = await saveEdition(fixture);
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    controls.contents
      .querySelector<HTMLAnchorElement>("a[data-target-anchor=note]")!
      .click();
    await vi.waitFor(() =>
      expect(controls.status.textContent).toContain("Fragment indisponible"),
    );
    expect(controls.returnToReference.hidden).toBe(false);
    controls.returnToReference.click();
    await vi.waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Note"),
    );
  });

  it("ouvre une cible dans un détail replié sans recharger le fragment ni son image", async () => {
    const urls = stubBlobUrls();
    const entry = await saveEdition(sample());
    const controls = makeControls();
    reader = startReader(controls);
    await reader.open(entry);
    controls.contents
      .querySelector<HTMLAnchorElement>("a[data-target-anchor=local]")!
      .click();
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe("blacture-anchor-local"),
    );
    expect(controls.contents.querySelector("details")?.open).toBe(true);
    expect(urls.create).toHaveBeenCalledTimes(1);
    controls.returnToReference.click();
    await vi.waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Dans le fragment"),
    );
    expect(urls.revoke).not.toHaveBeenCalled();
  });

  it("relit l’adresse locale et la préférence de taille, et revient à la bibliothèque", async () => {
    const entry = await saveEdition(sample("Œuvre #1"));
    await saveFontSize("small");
    history.replaceState(
      null,
      "",
      `#lecture?${new URLSearchParams({ book: entry.key, fragment: "child-a" })}`,
    );
    const controls = makeControls();
    reader = startReader(controls);
    await vi.waitFor(() =>
      expect(controls.contents.textContent).toContain("Texte de la note."),
    );
    expect(controls.contents.dataset.fontSize).toBe("small");
    controls.fontSize.value = "large";
    controls.fontSize.dispatchEvent(new Event("change"));
    await vi.waitFor(async () => expect(await readFontSize()).toBe("large"));
    expect(controls.contents.dataset.fontSize).toBe("large");
    controls.returnToLibrary.click();
    expect(controls.library.hidden).toBe(false);
    expect(controls.panel.hidden).toBe(true);
    expect(controls.contents.textContent).toBe("");
    expect(location.hash).toBe("");
  });

  it("enregistre la préférence et la correction avant un changement de version", async () => {
    stubBlobUrls();
    const book = sample();
    for (const fragment of book.fragments) {
      fragment.blockIds = [fragment.id];
      fragment.html = fragment.html.replace(
        "<p>",
        `<p data-block-id="${fragment.id}">`,
      );
    }
    const entry = await saveEdition(book);
    const controls = makeControls();
    for (const mode of ["auto", "read", "unread"])
      controls.progress.bookMode.add(new Option(mode, mode));
    reader = startReader(controls);
    await reader.open(entry);
    await vi.waitFor(() =>
      expect(controls.progress.bookMode.disabled).toBe(false),
    );
    controls.progress.bookMode.value = "read";
    controls.progress.bookMode.dispatchEvent(new Event("change"));
    controls.fontSize.value = "large";
    controls.fontSize.dispatchEvent(new Event("change"));
    const release = await reader.prepareUpdate();
    expect(controls.panel.inert).toBe(true);
    expect(await readFontSize()).toBe("large");
    release();
    expect(controls.panel.inert).toBe(false);
    expect(controls.progress.bookMode.disabled).toBe(false);
    expect(controls.progress.bookState.textContent).toContain("Terminé");
  });

  it("reprend au dernier bloc observé après un rechargement de version", async () => {
    const book = await import("../src/import").then(({ importMarkdown }) =>
      importMarkdown("# Chapitre\n\nPremier passage.\n\nSecond passage."),
    );
    const entry = await saveEdition(book);
    const watch = vi
      .spyOn(readingObserver, "watchReading")
      .mockImplementation((_contents, _toolbar, units, onSample) => {
        const second = units.at(-1)!;
        onSample({ id: second.id, elapsedMs: 0, coverage: 0 });
        return () => {};
      });
    try {
      const controls = makeControls();
      reader = startReader(controls);
      await reader.open(entry);
      await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
      await reader.prepareUpdate();
      expect(location.hash).not.toContain("block=");
      reader.preservePositionForReload();
      const position = await storage.readProgress(entry.key);
      expect(position.last?.blockId).toBeDefined();
      expect(
        new URLSearchParams(location.hash.split("?")[1]).get("block"),
      ).toBe(position.last?.blockId);
      const otherRoute = `#lecture?book=${encodeURIComponent(entry.key)}&fragment=autre`;
      history.replaceState(null, "", otherRoute);
      reader.preservePositionForReload();
      expect(location.hash).toBe(otherRoute);
    } finally {
      watch.mockRestore();
    }
  });

  it("rétablit le lecteur si une préférence en cours échoue pendant la préparation", async () => {
    const controls = makeControls();
    reader = startReader(controls);
    const savePreference = vi
      .spyOn(storage, "saveFontSize")
      .mockRejectedValueOnce(
        new DOMException("Disque plein", "QuotaExceededError"),
      );
    try {
      controls.fontSize.value = "large";
      controls.fontSize.dispatchEvent(new Event("change"));
      await expect(reader.prepareUpdate()).rejects.toThrow(/taille du texte/);
      expect(controls.status.textContent).toContain("Impossible d’enregistrer");
      expect(controls.panel.inert).toBe(false);
      const retry = await reader.prepareUpdate();
      retry();
    } finally {
      savePreference.mockRestore();
    }
  });
});
