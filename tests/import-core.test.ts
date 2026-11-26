// @vitest-environment node
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { importMarkdown } from "../src/import";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR4nGPQja9FQ89O9KAhhlFFAIjAnJFx1hCGAAAAAElFTkSuQmCC";

describe("Markdown import", () => {
  it("preserves headings inside structural HTML wrappers and the wrapper's own anchor", async () => {
    const source =
      '<section id="conteneur" class="editorial"><h2 id="a">A</h2><p>Parent.</p><div><h4 id="b">B</h4><p>Enfant.</p></div></section>';
    const book = await importMarkdown(source);
    expect(book.sections.map(({ title }) => title)).toEqual(["A", "B"]);
    expect(book.sections[1]!.parentId).toBe(book.sections[0]!.id);
    expect(book.fragments[0]!.html).toContain("Parent.");
    expect(book.fragments[0]!.html).not.toContain("Enfant.");
    expect(book.fragments[1]!.html).toContain("Enfant.");
    const wrapperId = book.destinations.conteneur!.elementId;
    expect(book.fragments[0]!.html).toContain(`id="${wrapperId}"`);
    expect(book.fragments[1]!.html).not.toContain(`id="${wrapperId}"`);
    expect(
      book.fragments.every((fragment) =>
        fragment.html.includes('class="editorial"'),
      ),
    ).toBe(true);
  });

  it("keeps escaped heading attribute syntax as literal editorial text", async () => {
    const book = await importMarkdown("# Titre \\{#reel}");
    expect(book.sections[0]!.title).toBe("Titre {#reel}");
    expect(Object.hasOwn(book.destinations, "reel")).toBe(false);
  });

  it("distinguishes where inline markup interrupts otherwise identical block text", async () => {
    const before = await importMarkdown("# Titre {#titre}\n\n<p>A<br>BC</p>");
    const after = await importMarkdown("# Titre {#titre}\n\n<p>AB<br>C</p>");
    expect(before.fragments[0]!.blockIds.at(-1)).not.toBe(
      after.fragments[0]!.blockIds.at(-1),
    );
  });

  it("retains an explicitly anchored block's identity when a duplicate of its text is removed", async () => {
    const first = '<p id="premier">Texte</p>';
    const second = '<p id="second">Texte</p>';
    const before = await importMarkdown(
      `# Titre {#titre}\n\n${first}${second}`,
    );
    const after = await importMarkdown(`# Titre {#titre}\n\n${second}`);
    expect(after.fragments[0]!.blockIds.at(-1)).toBe(
      before.fragments[0]!.blockIds.at(-1),
    );
    expect(after.fragments[0]!.blockIds.at(-1)).not.toBe(
      before.fragments[0]!.blockIds.at(-2),
    );
  });

  it("keeps implicit section identity when an unrelated parent gains a matching heading", async () => {
    const original =
      "# Premier {#premier}\n\nSa section.\n\n# Second {#second}\n\n## Notes\n\nUn texte inchangé.";
    const revised = original.replace(
      "Sa section.",
      "Sa section.\n\n## Notes\n\nDes notes ajoutées.",
    );
    const before = await importMarkdown(original);
    const after = await importMarkdown(revised);
    expect(after.sections.at(-1)?.id).toBe(before.sections.at(-1)?.id);
    expect(after.fragments.at(-1)?.blockIds).toEqual(
      before.fragments.at(-1)?.blockIds,
    );
  });

  it("records duplicate anchors and keeps legacy and punctuation anchors usable", async () => {
    const source =
      '# Héritage {#heritage}\n\n[Nom](#ancien) et <a href="#%mal">caractère littéral</a>.\n\n<a name="ancien"></a><span id="%mal">Signe</span>\n\n## Enfant {#heritage}\n\nTexte.';
    const book = await importMarkdown(source);
    const html = book.fragments.map((fragment) => fragment.html).join("");
    expect(html).toContain('data-target-anchor="ancien"');
    expect(html).toContain('data-target-anchor="%mal"');
    expect(book.diagnostics).toEqual([
      { code: "duplicate-anchor", severity: "error", count: 1 },
    ]);
    expect(book.destinations.heritage?.fragmentId).toBe(book.fragments[0]!.id);
  });

  it("stores only inert references for intentional external navigation", async () => {
    const book = await importMarkdown(
      '# Ressources\n\n[Externe](https://example.com/a) · [Courriel](mailto:someone@example.com) · [Relatif](./autre.md) · [Identification](https://user@example.com)\n\n<p aria-labelledby="absent">Légende</p>',
    );
    const html = book.fragments[0]!.html;
    expect(html).toContain('data-external-url="https://example.com/a"');
    expect(html).toContain('data-external-url="mailto:someone@example.com"');
    expect(html).not.toContain("href=");
    expect(html).not.toContain("user@example.com");
    expect(html).not.toContain("aria-labelledby=");
    expect(book.diagnostics).toEqual([
      { code: "unsupported-link", severity: "warning", count: 2 },
    ]);
  });

  it("preserves supported editorial styling and reports unsupported heading attributes", async () => {
    const book = await importMarkdown(
      `# Titre {#id .editorial lang=fr dir='ltr' title="Note liminaire" unknown=1}\n\n<span class="initiale" style="font-variant: small-caps;">Texte.</span> <img alt="Symbole" style="height:1em;width:auto;vertical-align:baseline" src="${png}">`,
    );
    const html = book.fragments[0]!.html;
    expect(html).toContain('class="editorial"');
    expect(html).toContain('lang="fr"');
    expect(html).toContain('dir="ltr"');
    expect(html).toContain('title="Note liminaire"');
    expect(html).toContain('class="initiale editorial-small-caps"');
    expect(html).toContain('class="editorial-inline-image"');
    expect(html).not.toContain("style=");
    expect(book.diagnostics).toEqual([
      { code: "unsupported-heading-attribute", severity: "warning", count: 1 },
    ]);
  });

  it("reports an empty document, and retains loose HTML text without inventing a heading", async () => {
    const empty = await importMarkdown("\n\n", { title: " Nom fourni " });
    const book = await importMarkdown("<div>Sans titre</div> Texte libre.");
    expect(empty.title).toBe("Nom fourni");
    expect(empty.sections).toEqual([]);
    expect(empty.diagnostics).toEqual([
      { code: "empty-document", severity: "error", count: 1 },
    ]);
    expect(book.title).toBe("Ouvrage sans titre");
    expect(book.sections[0]!.level).toBe(0);
    expect(book.fragments[0]!.html).toContain("Texte libre.");
  });

  it("keeps the prelude, own parent content, skipped levels and distinct repeated titles", async () => {
    const book = await importMarkdown(
      `Une préface.\n\n# Parent {#parent .entry}\n\nTexte propre.\n\n### Enfant\n\n水\n\n### Enfant\n\n## Finale`,
    );
    const [intro, parent, first, second, final] = book.sections;
    expect(book.sections.map(({ level, title }) => [level, title])).toEqual([
      [0, "Introduction"],
      [1, "Parent"],
      [3, "Enfant"],
      [3, "Enfant"],
      [2, "Finale"],
    ]);
    expect(intro!.parentId).toBe(null);
    expect(first!.parentId).toBe(parent!.id);
    expect(second!.parentId).toBe(parent!.id);
    expect(final!.parentId).toBe(parent!.id);
    expect(first!.id).not.toBe(second!.id);
    const parentFragment = book.fragments.find(
      (fragment) => fragment.sectionId === parent!.id,
    );
    expect(parentFragment!.html).toContain("Texte propre");
    expect(parentFragment!.html).toContain('class="entry"');
    expect(parentFragment!.html).not.toContain("水");
    expect(
      book.fragments.some((fragment) => fragment.html.includes("水")),
    ).toBe(true);
    expect(book.title).toBe("Parent");
  });

  it("keeps editorial note anchors and exact cross-fragment destinations including special keys", async () => {
    const book = await importMarkdown(
      `# Notes\n\nTexte <sup id="appel">[1](#%C3%A9cho)</sup> et [un autre](#__proto__).\n\n## Annexe\n\n<section data-role="notes"><p id="écho">Note <a href="#appel">Retour</a></p><p id="__proto__">Cible</p></section>`,
    );
    expect(book.diagnostics).toEqual([]);
    const first = book.fragments[0];
    const last = book.fragments.at(-1);
    expect(first?.html).toContain('data-target-anchor="écho"');
    expect(last?.html).toContain('data-target-anchor="appel"');
    expect(last?.html).toContain('data-role="notes"');
    expect(book.destinations["écho"]?.fragmentId).toBe(last?.id);
    expect(last?.html).toContain(
      `id="${book.destinations["écho"]?.elementId}"`,
    );
    expect(Object.hasOwn(book.destinations, "__proto__")).toBe(true);
    expect(book.destinations["__proto__"]?.fragmentId).toBe(last?.id);
  });

  it("keeps Markdown and HTML tables, details, footnotes and Chinese text", async () => {
    const source =
      "# Texte\n\nA[^note]\n\n| Colonne | Valeur |\n| --- | --- |\n| 漢字 | B |\n\n<details><summary>Variante</summary><table><tr><td>比較</td></tr></table></details>\n\n[^note]: Une note.";
    const book = await importMarkdown(source);
    const html = book.fragments.map((fragment) => fragment.html).join("");
    for (const expected of [
      "<details",
      "<summary",
      "<th",
      "<td>比較</td>",
      "漢字",
      "Une note.",
      "data-target-anchor",
    ]) {
      expect(html).toContain(expected);
    }
    expect(book.diagnostics).toEqual([]);
  });

  it("extracts embedded raster bytes once, preserving the different references", async () => {
    const book = await importMarkdown(
      `# Photos\n\n![Première](${png})\n\n## Seconde\n\n<img src="${png}" alt="Deuxième" width="12" height="2">`,
    );
    expect(book.resources).toHaveLength(1);
    const resource = book.resources[0];
    expect(resource?.mimeType).toBe("image/png");
    expect(resource?.bytes.slice(0, 4)).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
    expect(book.fragments.map((fragment) => fragment.resourceIds)).toEqual([
      [resource?.id],
      [resource?.id],
    ]);
    expect(book.fragments[1]?.html).toContain(
      `data-resource-id="${resource?.id}"`,
    );
    expect(book.fragments[1]?.html).toContain('alt="Deuxième"');
    expect(book.fragments[1]?.html).not.toContain("data:image");
  });

  it("preserves resource-shaped text in code alongside a long embedded image", async () => {
    const original = Buffer.from(png.split(",")[1]!, "base64");
    const comment = Buffer.from("Comment\u0000" + "A".repeat(3_000));
    const chunk = Buffer.alloc(comment.length + 12);
    chunk.writeUInt32BE(comment.length);
    chunk.write("tEXt", 4);
    comment.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const expanded = Buffer.concat([
      original.subarray(0, -12),
      chunk,
      original.subarray(-12),
    ]);
    const sourceUrl = `data:image/png;base64,${expanded.toString("base64")}`;
    const book = await importMarkdown(
      `# Longue image\n\n\`${sourceUrl}\`\n\n![Photo](${sourceUrl})`,
    );
    expect(book.resources).toHaveLength(1);
    const html = book.fragments[0]!.html;
    expect(html).toContain(`<code>${sourceUrl}</code>`);
    expect(html).toContain(`data-resource-id="${book.resources[0]!.id}"`);
  });

  it("removes active markup and reports missing resources or destinations", async () => {
    const book = await importMarkdown(
      `# A\n\n[Renvoi](#absent)\n\n![Photo](./photo.png)\n\n<script>Texte actif</script>\n\n<p onclick="noop()" data-resource-id="forged" style="background: url('/a')">Texte sain</p>`,
    );
    const html = book.fragments[0]?.html ?? "";
    expect(html).toContain("Texte sain");
    expect(html).toContain("Photo");
    for (const forbidden of [
      "<script",
      "Texte actif",
      "onclick",
      "forged",
      "background",
      "./photo.png",
      'data-target-anchor="absent"',
    ]) {
      expect(html).not.toContain(forbidden);
    }
    expect(book.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsafe-markup", severity: "warning" }),
        expect.objectContaining({
          code: "missing-resource",
          severity: "error",
        }),
        expect.objectContaining({
          code: "unresolved-anchor",
          severity: "error",
        }),
      ]),
    );
  });

  it("normalizes source line endings and BOM and preserves unchanged block IDs in distinct editions", async () => {
    const source = "# Titre {#titre}\n\nIdentique.\n\nChange.";
    const first = await importMarkdown(source, { workId: "stable-work" });
    const encodedDifferently = await importMarkdown(
      `\uFEFF${source.replaceAll("\n", "\r\n")}`,
      { workId: "stable-work" },
    );
    const changed = await importMarkdown(
      source.replace("Change.", "Modifié."),
      { workId: "stable-work" },
    );
    expect(encodedDifferently).toEqual(first);
    expect(changed.workId).toBe(first.workId);
    expect(changed.editionId).not.toBe(first.editionId);
    expect(changed.sections[0]?.id).toBe(first.sections[0]?.id);
    expect(changed.fragments[0]?.blockIds[0]).toBe(
      first.fragments[0]?.blockIds[0],
    );
    expect(changed.fragments[0]?.blockIds.at(-1)).not.toBe(
      first.fragments[0]?.blockIds.at(-1),
    );
  });

  it("can abort and splits a large section at the next complete block", async () => {
    const signal = AbortSignal.abort(new Error("stopped"));
    await expect(importMarkdown("a", { signal })).rejects.toThrow("stopped");
    const book = await importMarkdown(
      `# Long\n\n${"a".repeat(150_000)}\n\n${"b".repeat(150_000)}`,
    );
    expect(book.sections).toHaveLength(1);
    expect(book.fragments).toHaveLength(2);
    expect(book.fragments[0]?.html).toContain("a".repeat(150_000));
    expect(book.fragments[1]?.html).toContain("b".repeat(150_000));
  });
});
