import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { importMarkdown } from "../src/import/index";

type Book = Awaited<ReturnType<typeof importMarkdown>>;

const fixturePath = `${process.cwd()}/tests/fixtures/b02/editorial.md`;

function parseHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function combinedHtml(book: Book): DocumentFragment {
  return parseHtml(book.fragments.map((fragment) => fragment.html).join("\n"));
}

function fragmentForAnchor(book: Book, key: string): DocumentFragment {
  const destination = book.destinations[key];
  const fragment = book.fragments.find(
    (entry) => entry.id === destination?.fragmentId,
  );
  if (!destination || !fragment) throw new Error(`No destination for ${key}`);
  const rendered = parseHtml(fragment.html);
  expect(rendered.getElementById(destination.elementId)).not.toBeNull();
  return rendered;
}

function blockForText(book: Book, text: string): string | undefined {
  const blocks =
    combinedHtml(book).querySelectorAll<HTMLElement>("[data-block-id]");
  return [...blocks].find((element) => element.textContent === text)?.dataset
    .blockId;
}

function addPngComment(image: Buffer): Buffer {
  // Insert a valid ancillary tEXt chunk before the final twelve-byte IEND chunk.
  const comment = Buffer.from(`Comment\0${"A".repeat(2400)}`, "latin1");
  const type = Buffer.from("tEXt");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(comment.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, comment])));
  return Buffer.concat([
    image.subarray(0, -12),
    size,
    type,
    comment,
    checksum,
    image.subarray(-12),
  ]);
}

describe("B02 independent editorial acceptance", () => {
  it("keeps preface, parent content, repeated titles and the editorial block sequence", async () => {
    const book = await importMarkdown(await readFile(fixturePath, "utf8"));
    const parent = book.sections.find(
      (section) => section.title === "Atlas des jardins",
    );
    const children = book.sections.filter(
      (section) => section.title === "Promenade",
    );
    expect(
      book.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(parent).toBeDefined();
    expect(children).toHaveLength(2);
    expect(children.map(({ parentId, level }) => [parentId, level])).toEqual([
      [parent?.id, 3],
      [parent?.id, 3],
    ]);
    expect(new Set(children.map(({ id }) => id)).size).toBe(2);

    const parentOwnText = book.fragments
      .filter(({ sectionId }) => sectionId === parent?.id)
      .map(({ html }) => html)
      .join("\n");
    expect(parentOwnText).toContain("Contenu propre du parent");
    expect(parentOwnText).not.toContain("Le premier sentier");

    const rendered = combinedHtml(book);
    expect(rendered.textContent).toMatch(
      /Préface[\s\S]*道、山、水[\s\S]*premier sentier[\s\S]*second sentier[\s\S]*pavillon servait/u,
    );
    expect(rendered.textContent).toContain("« voilà ! »");
    expect(
      [...rendered.querySelectorAll("table th")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["Saison", "Plantation", "Relief"]);
    expect(rendered.querySelector("details summary")?.textContent).toBe(
      "Observer le paysage",
    );
  });

  it("indexes cross-fragment links, editorial note calls and returns", async () => {
    const book = await importMarkdown(await readFile(fixturePath, "utf8"));
    const call = fragmentForAnchor(book, "appel-jardin");
    const note = fragmentForAnchor(book, "note-jardin");
    const overlook = fragmentForAnchor(book, "belvedere");
    expect(
      call.querySelector('sup a[data-target-anchor="note-jardin"]')
        ?.textContent,
    ).toBe("1");
    expect(
      call.querySelector('a[data-target-anchor="belvedere"]')?.textContent,
    ).toContain("renvoi au belvédère");
    expect(
      note.querySelector('a[data-target-anchor="appel-jardin"]')?.textContent,
    ).toBe("Retour à l’appel");
    expect(overlook.textContent).toContain("Le second sentier");
    expect(book.destinations["appel-jardin"]?.fragmentId).not.toBe(
      book.destinations["note-jardin"]?.fragmentId,
    );
    const reference = [
      ...call.querySelectorAll("sup a[data-target-anchor]"),
    ].find((link) => link.getAttribute("data-target-anchor") !== "note-jardin");
    const noteKey = reference?.getAttribute("data-target-anchor");
    if (!noteKey) throw new Error("No destination for the Markdown footnote");
    const markdownNote = fragmentForAnchor(book, noteKey);
    const returnKey = Object.keys(book.destinations).find(
      (key) => book.destinations[key]?.elementId === reference?.id,
    );
    expect(markdownNote.textContent).toContain(
      "Le versant est ombragé en fin d’après-midi.",
    );
    expect(returnKey).toBeTruthy();
    expect(
      markdownNote.querySelector(`a[data-target-anchor="${returnKey}"]`),
    ).not.toBeNull();
  });

  it("imports a standalone document with no headings", async () => {
    const book = await importMarkdown(
      "Un récit bref.\n\nUne seconde strophe, avec 春.",
      {
        title: "Carnet sans titre interne",
      },
    );
    expect(book.title).toBe("Carnet sans titre interne");
    expect(
      book.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(combinedHtml(book).textContent).toMatch(
      /Un récit bref\.[\s\S]*Une seconde strophe, avec 春\./u,
    );
  });

  it("extracts a shared binary for equivalent HTML and Markdown raster images", async () => {
    const book = await importMarkdown(await readFile(fixturePath, "utf8"));
    const images = [...combinedHtml(book).querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("alt"))).toEqual([
      "Croquis du jardin",
      "Croquis répété",
    ]);
    expect(book.resources).toHaveLength(1);
    const resource = book.resources[0];
    expect(resource?.mimeType).toBe("image/png");
    expect(Array.from(resource?.bytes.slice(0, 8) ?? [])).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    for (const image of images) {
      expect(image.getAttribute("data-resource-id")).toBe(resource?.id);
      expect(image.hasAttribute("src")).toBe(false);
    }
    expect(
      book.fragments.filter((fragment) => fragment.resourceIds.length > 0),
    ).toHaveLength(2);
  });

  it("preserves a long data URI quoted as text while extracting the identical image source", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const existing = /data:image\/png;base64,([A-Za-z0-9+/=]+)/u.exec(
      fixture,
    )?.[1];
    if (!existing) throw new Error("Synthetic PNG missing");
    const png = addPngComment(Buffer.from(existing, "base64"));
    const url = `data:image/png;base64,${png.toString("base64")}`;
    const source = [
      "# Exemple d’édition",
      `![Grand dessin](${url})`,
      `\`${url}\``,
    ].join("\n\n");
    const book = await importMarkdown(source);

    expect(
      book.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(book.resources).toHaveLength(1);
    expect(Buffer.from(book.resources[0]?.bytes ?? [])).toEqual(png);
    expect(combinedHtml(book).querySelector("code")?.textContent).toBe(url);
  });

  it("gives unchanged blocks a stable identity across a new edition", async () => {
    const options = { workId: "synthetic-edition-comparison" };
    const source =
      "# Carnet {#carnet}\n\nPhrase constante.\n\nTexte à corriger.\n";
    const edited = source
      .replace("Phrase constante.", "Avant-propos ajouté.\n\nPhrase constante.")
      .replace("Texte à corriger.", "Texte corrigé.");
    const first = await importMarkdown(source, options);
    const updated = await importMarkdown(edited, options);
    const unchanged = blockForText(first, "Phrase constante.");
    const oldBlock = blockForText(first, "Texte à corriger.");
    const newBlock = blockForText(updated, "Texte corrigé.");

    expect(first.workId).toBe(updated.workId);
    expect(first.editionId).not.toBe(updated.editionId);
    expect(unchanged).toBeTruthy();
    expect(blockForText(updated, "Phrase constante.")).toBe(unchanged);
    expect(oldBlock).toBeTruthy();
    expect(newBlock).toBeTruthy();
    expect(newBlock).not.toBe(oldBlock);
  });

  it("rejects embedded active or nonlocal resources while retaining safe text", async () => {
    const book = await importMarkdown(
      [
        "# Document de contrôle",
        '<p onclick="discard">Texte éditorial intact.</p>',
        '<script type="application/json">"contrôle"</script>',
        '<img alt="Ressource distante" src="https://invalid.example/image.png">',
        '<a href="file:///nonlocal.txt">Document local externe</a>',
      ].join("\n\n"),
    );
    const rendered = combinedHtml(book);
    expect(rendered.textContent).toContain("Texte éditorial intact.");
    expect(
      rendered.querySelector("script, [onclick], [src], [href^='file:']"),
    ).toBeNull();
    expect(book.resources).toEqual([]);
    expect(book.diagnostics.length).toBeGreaterThan(0);
  });
});
