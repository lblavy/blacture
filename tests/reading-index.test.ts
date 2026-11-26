import "fake-indexeddb/auto";
import { beforeEach, expect, it, vi } from "vitest";
import { importMarkdown, type ImportedBook } from "../src/import";
import { extractReadingUnits } from "../src/reading-index";
import { readManifest, readReadingIndex, saveEdition } from "../src/storage";

const html = `
  <h2 data-block-id="heading">Titre purement structurel</h2>
  <p data-block-id="text">  Texte&nbsp; <a data-target-anchor="note">utile</a>
    <sup><a role="doc-noteref" data-target-anchor="note">1</a></sup>
  </p>
  <nav data-block-id="toc"><a data-target-anchor="a">Sommaire</a></nav>
  <div data-block-id="legacy-toc" data-toc>Chapitres : <a data-target-anchor="a">Premier</a></div>
  <p data-block-id="jump"><a data-target-anchor="x">Aller au chapitre suivant</a></p>
  <p data-block-id="many-links"><a data-target-anchor="x">Un</a> <a href="#y">Deux</a></p>
  <p data-block-id="reference"><a data-external-url="https://example.test/">Source</a></p>
  <section role="doc-endnotes"><p data-block-id="endnote">Note de fin</p></section>
  <section data-footnotes><p data-block-id="footnote">Autre note</p></section>
  <figure data-block-id="image"><img data-resource-id="one" alt="Une carte"></figure>
  <p data-block-id="empty"> &nbsp; </p>`;

function book(editionId = "one"): ImportedBook {
  return {
    schemaVersion: 1,
    workId: "work",
    editionId,
    title: "Témoin",
    sections: [
      {
        id: "parent",
        title: "Partie",
        level: 1,
        parentId: null,
        fragmentIds: ["first"],
      },
      {
        id: "child",
        title: "Enfant",
        level: 2,
        parentId: "parent",
        fragmentIds: ["second"],
      },
    ],
    fragments: [
      {
        id: "first",
        sectionId: "parent",
        html,
        blockIds: ["text", "image"],
        resourceIds: [],
      },
      {
        id: "second",
        sectionId: "child",
        html: '<p data-block-id="last">Enfant.</p>',
        blockIds: ["last"],
        resourceIds: [],
      },
    ],
    destinations: {},
    resources: [],
    diagnostics: [],
  };
}

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("blacture-library");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

it("pondère le texte normalisé et les images sans compter titres, notes ou navigation", () => {
  expect(extractReadingUnits(html)).toEqual([
    { id: "text", weight: 11 },
    { id: "reference", weight: 6 },
    { id: "image", weight: 80 },
  ]);
});

it("préserve les marqueurs éditoriaux à l’import et indexe seulement le texte à lire", async () => {
  const imported = await importMarkdown(`
# Introduction

<!-- A real import must preserve navigation semantics before the reader builds its index. -->
<div data-toc>Chapitres : <a href="#passage">Premier</a></div>

<div role="navigation">Navigation : <a href="#passage">Début</a></div>

<div role="doc-toc">Sommaire : <a href="#passage">Introduction</a></div>

<p id="passage">Une idée<a role="doc-noteref" href="#note">[1]</a><a role="doc-backlink" href="#passage">Retour</a>.</p>

<!-- Destinations are retained, but their notes are outside the reading denominator. -->
<section id="note" role="doc-endnotes"><p>Note de fin.</p></section>

<aside role="doc-footnote">Autre note.</aside>

<p role="button">Texte conservé.</p>
`);
  const retainedHtml = imported.fragments
    .map((fragment) => fragment.html)
    .join("");
  const units = imported.fragments.flatMap((fragment) =>
    extractReadingUnits(fragment.html, fragment.blockIds),
  );
  expect(units.map((unit) => unit.weight)).toEqual([
    "Une idée.".length,
    "Texte conservé.".length,
  ]);
  for (const role of [
    "navigation",
    "doc-toc",
    "doc-noteref",
    "doc-backlink",
    "doc-endnotes",
    "doc-footnote",
  ])
    expect(retainedHtml).toContain(`role="${role}"`);
  expect(retainedHtml).toContain("data-toc");
  expect(retainedHtml).not.toContain('role="button"');
  expect(imported.diagnostics).toContainEqual({
    code: "unsupported-attribute",
    severity: "warning",
    count: 1,
  });
});

it("dérive l’index par fragment d’une édition B03, respecte l’ordre du manifeste et le met en cache", async () => {
  const existing = await saveEdition(book());
  const other = book("two");
  other.fragments[0]!.html =
    '<p data-block-id="not-this-edition">Autre édition.</p>';
  await saveEdition(other);
  const manifest = (await readManifest(existing.key))!;
  const cursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
  try {
    const derived = await readReadingIndex(existing.key, manifest);
    expect(derived.sections).toEqual([
      { id: "parent", parentId: null, fragmentIds: ["first"] },
      { id: "child", parentId: "parent", fragmentIds: ["second"] },
    ]);
    expect(derived.fragments).toEqual({
      first: extractReadingUnits(html),
      second: [{ id: "last", weight: 7 }],
    });
    expect(await readReadingIndex(existing.key, manifest)).toEqual(derived);
    expect(cursor).toHaveBeenCalledOnce();
  } finally {
    cursor.mockRestore();
  }
});

it("écarte un index incomplet ou une clé incohérente et ne met pas de résultat partiel en cache", async () => {
  const edited = book();
  edited.fragments.pop();
  const { key } = await saveEdition(edited);
  const manifest = (await readManifest(key))!;
  await expect(readReadingIndex(key, manifest)).rejects.toThrow(
    "Fragment introuvable",
  );
  await expect(readReadingIndex("other", manifest)).rejects.toThrow(
    "Édition incohérente",
  );
  await expect(
    readReadingIndex(key, manifest, AbortSignal.abort()),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(readReadingIndex(key, manifest)).rejects.toThrow(
    "Fragment introuvable",
  );
});

it("accepte un ouvrage vide sans le confondre avec des fragments introuvables", async () => {
  const empty = book();
  empty.sections = [];
  empty.fragments = [];
  const { key } = await saveEdition(empty);
  expect(await readReadingIndex(key, (await readManifest(key))!)).toEqual({
    sections: [],
    fragments: {},
  });
});

it("partage le même parcours entre lecteurs et permet à un seul de l’annuler", async () => {
  const { key } = await saveEdition(book());
  const manifest = (await readManifest(key))!;
  const controller = new AbortController();
  const cursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
  try {
    const cancelled = readReadingIndex(key, manifest, controller.signal);
    const other = readReadingIndex(key, manifest);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(await other).toMatchObject({
      fragments: { second: [{ id: "last", weight: 7 }] },
    });
    expect(cursor).toHaveBeenCalledOnce();
  } finally {
    cursor.mockRestore();
  }
});

it("arrête le parcours si son dernier lecteur annule puis permet un nouvel essai", async () => {
  const { key } = await saveEdition(book());
  const manifest = (await readManifest(key))!;
  const controller = new AbortController();
  const openCursor = IDBObjectStore.prototype.openCursor;
  const cursor = vi
    .spyOn(IDBObjectStore.prototype, "openCursor")
    .mockImplementationOnce(function (
      this: IDBObjectStore,
      ...args: Parameters<typeof openCursor>
    ) {
      const request = openCursor.apply(this, args);
      controller.abort();
      return request;
    });
  try {
    await expect(
      readReadingIndex(key, manifest, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readReadingIndex(key, manifest)).toMatchObject({
      fragments: { second: [{ id: "last", weight: 7 }] },
    });
    expect(cursor).toHaveBeenCalledTimes(2);
  } finally {
    cursor.mockRestore();
  }
});

it("refuse les identifiants ambigus et les fragments rattachés à la mauvaise section", async () => {
  const duplicated = book("duplicated");
  duplicated.fragments[1]!.html =
    '<p data-block-id="text">Identifiant répété.</p>';
  duplicated.fragments[1]!.blockIds = ["text"];
  const duplicate = await saveEdition(duplicated);
  await expect(
    readReadingIndex(duplicate.key, (await readManifest(duplicate.key))!),
  ).rejects.toThrow("Identifiant de passage en double");

  const invalid = book("invalid");
  invalid.fragments[1]!.sectionId = "parent";
  const mismatch = await saveEdition(invalid);
  await expect(
    readReadingIndex(mismatch.key, (await readManifest(mismatch.key))!),
  ).rejects.toThrow("Fragment incohérent");

  const manifest = (await readManifest(mismatch.key))!;
  manifest.sections[0]!.fragmentIds.push("second");
  await expect(readReadingIndex(mismatch.key, manifest)).rejects.toThrow(
    "Fragment déclaré plusieurs fois",
  );
});

it("refuse un fragment dont le HTML a perdu un identifiant déclaré", async () => {
  const broken = book();
  broken.fragments[1]!.html = "<p>Passage sans identifiant.</p>";
  const { key } = await saveEdition(broken);
  await expect(
    readReadingIndex(key, (await readManifest(key))!),
  ).rejects.toThrow("Fragment incohérent");
});

it("compte un conteneur décoré une seule fois et reconnaît un bloc image direct", () => {
  expect(
    extractReadingUnits(
      '<div data-block-id="outer"><p data-block-id="inner">Passage.</p></div><img data-block-id="direct">',
    ),
  ).toEqual([
    { id: "outer", weight: 8 },
    { id: "direct", weight: 80 },
  ]);
});
