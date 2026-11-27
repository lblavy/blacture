// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { importMarkdown } from "../src/import";
import { sha256 } from "../src/import/identity";
import {
  assembleEditionPackage,
  decodeEditionPackage,
  encodeEditionPackage,
} from "../src/sync/edition-package";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR4nGPQja9FQ89O9KAhhlFFAIjAnJFx1hCGAAAAAElFTkSuQmCC";
const book = await importMarkdown(
  `# Départ {#depart}

[Suite](#suite) et [référence](https://example.test/page).

![Symbole](${png})

<details open><summary>Extrait</summary><p>Récit.</p></details>

## Suite {#suite}

| Un | Deux |
| -- | -- |
| X | Y |
`,
);
const expectedKey = JSON.stringify([book.workId, book.editionId]);
const bytes = book.resources[0]!.bytes;

function modifiedHtml(html: (previous: string) => string) {
  const encoded = encodeEditionPackage(book);
  const data = JSON.parse(encoded) as { fragments: { html: string }[] };
  data.fragments[0]!.html = html(data.fragments[0]!.html);
  return JSON.stringify(data);
}

describe("paquet d’édition Drive", () => {
  it("reconstruit l’import, ses renvois et ses ressources sans mettre les images dans le JSON", async () => {
    const json = encodeEditionPackage(book);
    expect(json).toBe(encodeEditionPackage(book));
    expect(json).not.toContain("base64");
    const decoded = decodeEditionPackage(json, expectedKey);
    const load = vi.fn().mockResolvedValue(bytes);
    expect(await assembleEditionPackage(decoded, load)).toEqual(book);
    expect(load).toHaveBeenCalledExactlyOnceWith({
      id: book.resources[0]!.id,
      mimeType: "image/png",
      size: bytes.byteLength,
    });
  });

  it.each([
    (html: string) => html.replace("</h1>", "<script>alerte</script></h1>"),
    (html: string) => `<body onload="alert(1)">${html}</body>`,
    (html: string) =>
      html.replace("<img ", '<img src="https://example.test/pixel" '),
    (html: string) => html.replace("<img ", '<img onerror="alert(1)" '),
    (html: string) =>
      html.replace("<a ", '<a href="https://example.test/pixel" '),
    (html: string) =>
      html.replace("https://example.test/page", "&#x6a;avascript:alert(1)"),
    (html: string) =>
      html.replace(
        "https://example.test/page",
        "https://user@example.test/page",
      ),
    (html: string) =>
      html.replace('data-target-anchor="suite"', 'data-target-anchor="absent"'),
    (html: string) =>
      html.replace(
        'data-target-anchor="suite"',
        'data-target-anchor="suite" data-external-url="https://example.test/"',
      ),
    (html: string) =>
      html.replace("</h1>", '<span data-block-id="interne">Texte</span></h1>'),
    (html: string) => html.replace("https://example.test/page", "/incomplet"),
    (html: string) =>
      html.replace(/data-block-id="[^"]+"/u, 'data-block-id="autre"'),
    (html: string) =>
      html.replace(/id="blacture-anchor-[^"]+"/u, 'id="reader"'),
    (html: string) =>
      html.replace("</h1>", '<span id="">Sans identifiant</span></h1>'),
  ])(
    "rejette une altération HTML avant tout chargement de ressource",
    (change) => {
      expect(() =>
        decodeEditionPackage(modifiedHtml(change), expectedKey),
      ).toThrow();
    },
  );

  it("conserve les notes, les blocs de code et les reprises d’attributs éditoriaux", async () => {
    const source = await importMarkdown(
      [
        "Introduction libre.",
        "",
        "# Titre {#en-tete .editorial}",
        "",
        "Ouverture[^note].",
        "",
        "```html",
        "<script>littéral</script>",
        "```",
        "",
        "<pre>",
        "",
        "Texte mis en forme.",
        "</pre>",
        "",
        "::: {.annotation}",
        "Sans &lt;balise&gt;.",
        ":::",
        "",
        "[^note]: Une note [détaillée](#en-tete).",
      ].join("\n"),
    );
    const pkg = decodeEditionPackage(encodeEditionPackage(source));
    expect(pkg.fragments).toEqual(source.fragments);
    expect(pkg.manifest.destinations).toEqual(source.destinations);
  });

  it("réencode à l’identique malgré l’ordre de lecture des ressources et destinations", async () => {
    const anotherPng =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WioAAAAASUVORK5CYII=";
    const source = await importMarkdown(
      `# A {#z}\n\n![Un](${png})\n\n## B {#a}\n\n![Deux](${anotherPng})`,
    );
    const json = encodeEditionPackage(source);
    expect(source.resources).toHaveLength(2);
    expect(
      encodeEditionPackage({
        ...source,
        destinations: Object.fromEntries(
          Object.entries(source.destinations).reverse(),
        ),
        resources: [...source.resources].reverse(),
      }),
    ).toBe(json);
    const reassembled = await assembleEditionPackage(
      decodeEditionPackage(json),
      async ({ id }) =>
        source.resources.find((resource) => resource.id === id)!.bytes,
    );
    expect(encodeEditionPackage(reassembled)).toBe(json);
  });

  it("rejette une autre édition, un parent inexistant et une destination incohérente", () => {
    const json = encodeEditionPackage(book);
    expect(() => decodeEditionPackage(json, "autre")).toThrow(/identit/iu);
    const packageData = JSON.parse(json) as ReturnType<
      typeof decodeEditionPackage
    >;
    packageData.manifest.sections[1]!.parentId = "inexistant";
    expect(() => decodeEditionPackage(JSON.stringify(packageData))).toThrow();
    packageData.manifest.sections[1]!.parentId = book.sections[1]!.parentId;
    packageData.manifest.destinations.suite!.fragmentId = book.fragments[0]!.id;
    expect(() => decodeEditionPackage(JSON.stringify(packageData))).toThrow();
  });

  it.each([
    (json: string) => json.slice(1),
    (json: string) => json.replace('"schemaVersion":1', '"schemaVersion":2'),
    (json: string) => json.replace('"workId":', '"otherId":'),
    (json: string) => json.replace('"fragments":[', '"fragments":{'),
    (json: string) => json.replace('"level":1', '"level":7'),
    (json: string) => json.replace('"image/png"', '"image/svg+xml"'),
    (json: string) => json.replace(/"size":\d+/u, '"size":0'),
    (json: string) =>
      json.replace(
        '"diagnostics":[]',
        '"diagnostics":[{"code":"perte","severity":"error","count":1}]',
      ),
  ])("rejette un paquet mal formé ou d’un format inconnu", (change) => {
    expect(() =>
      decodeEditionPackage(change(encodeEditionPackage(book))),
    ).toThrow();
  });

  it("refuse les doublons de fragments ou ressources et les ressources non référencées", () => {
    const decoded = decodeEditionPackage(encodeEditionPackage(book));
    const resource = decoded.resources[0]!;
    const fragment = decoded.fragments[0]!;
    const invalidPackages = [
      { ...decoded, fragments: [fragment, ...decoded.fragments] },
      { ...decoded, resources: [resource, resource] },
      { ...decoded, resources: [] },
      { ...decoded, resources: [{ ...resource, id: "0".repeat(64) }] },
    ];
    for (const invalid of invalidPackages)
      expect(() => decodeEditionPackage(JSON.stringify(invalid))).toThrow();
  });

  it("rejette une ressource tronquée, modifiée ou qui n’est pas du MIME prévu", async () => {
    const json = encodeEditionPackage(book);
    const decoded = decodeEditionPackage(json);
    await expect(
      assembleEditionPackage(decoded, async () => bytes.slice(1)),
    ).rejects.toThrow(/taille/iu);
    const changed = bytes.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await expect(
      assembleEditionPackage(decoded, async () => changed),
    ).rejects.toThrow(/empreinte/iu);
    const impossibleRaster = new Uint8Array(bytes.length);
    const alternate = json.replaceAll(
      book.resources[0]!.id,
      await sha256(impossibleRaster),
    );
    await expect(
      assembleEditionPackage(
        decodeEditionPackage(alternate),
        async () => impossibleRaster,
      ),
    ).rejects.toThrow(/image/iu);
  });
});
