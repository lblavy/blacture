// @vitest-environment node
import { expect, it } from "vitest";
import { importMarkdown } from "../src/import";

it("importe les conteneurs Pandoc imbriqués en conservant titres, ancres et références", async () => {
  const markdown = [
    "# Premier {#premier}",
    "",
    "[Suite](#annexe) et [source de référence][source].",
    "",
    ":::: {#encadre .editorial .ouverture}",
    "Premier *passage*.",
    "",
    "::: {#annexe .intérieur}",
    "## Annexe {#section}",
    "Le texte de l’annexe[^note].",
    ":::",
    "La fin de l’encadré.",
    "::::",
    "",
    "Après l’encadré.",
    "",
    "[source]: #section",
    "[^note]: Une note conservée.",
  ].join("\n");
  const book = await importMarkdown(markdown);
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(book.sections.map((section) => section.title)).toEqual([
    "Premier",
    "Annexe",
  ]);
  expect(book.sections[1]?.parentId).toBe(book.sections[0]?.id);
  for (const content of [
    'class="editorial ouverture"',
    'class="intérieur"',
    "<em>passage</em>",
    'data-target-anchor="annexe"',
    'data-target-anchor="section"',
    "Une note conservée.",
  ])
    expect(html).toContain(content);
  expect(html).not.toContain(":::");
  expect(html.indexOf("La fin de l’encadré.")).toBeLessThan(
    html.indexOf("Après l’encadré."),
  );
  expect(book.destinations.encadre).toBeDefined();
  expect(book.diagnostics).toEqual([]);
});

it("préserve le texte des marqueurs sans paire et les marqueurs littéraux", async () => {
  const markdown = [
    "# Marqueurs",
    "",
    ":::",
    "",
    "::: {.sans-fermeture}",
    "Du texte à conserver.",
    "",
    "```md",
    "::: {.code}",
    ":::",
    "```",
    "",
    "    ::: {.indente}",
    "    :::",
    "",
    "Un `code en ligne",
    ":::",
    "encore en ligne`.",
    "",
    "<pre>::: {.html}",
    ":::",
    "</pre>",
    "",
    "\\::: {.échappé}",
    "",
    "&#58;:: {.entité}",
  ].join("\n");
  const book = await importMarkdown(markdown);
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(html.match(/:::/g)).toHaveLength(11);
  expect(html).toContain("Du texte à conserver.");
  expect(html).toContain("<code>code en ligne ::: encore en ligne</code>");
  expect(html).not.toContain('class="sans-fermeture"');
  expect(book.diagnostics).toEqual([
    { code: "unmatched-container-marker", severity: "warning", count: 2 },
  ]);
});

it("respecte les limites des lignes physiques et conserve le HTML assaini", async () => {
  const book = await importMarkdown(
    [
      "# Décor",
      "",
      "::: {.littéral}**Contenu**",
      "",
      "   ::: {#envol .volet}",
      "::: {.intérieur}",
      '**Texte** <span onclick="alert(0)">assaini</span>',
      ":::",
      "   :::",
      "",
      "::: {.inconnu onclick=actif}",
    ].join("\n"),
  );
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(html).toContain('class="volet"');
  expect(html).toContain('class="intérieur"');
  expect(html).toContain("<strong>Texte</strong> <span>assaini</span>");
  expect(html).toContain("::: {.littéral}<strong>Contenu</strong>");
  expect(html).toContain("::: {.inconnu onclick=actif}");
  expect(html).not.toContain("<span onclick=");
  expect(book.diagnostics).toEqual([
    { code: "unmatched-container-marker", severity: "warning", count: 1 },
    { code: "unsupported-attribute", severity: "warning", count: 1 },
    { code: "unsafe-markup", severity: "warning", count: 1 },
  ]);
});

it("laisse le code HTML en ligne littéral et le contenu actif dans la zone assainie", async () => {
  const book = await importMarkdown(`# Littéral

Exemple <code>
::: {.note}
Code affiché.
:::
</code>.

Exemple <script>
::: {.script}
Contenu interne supprimé.
:::
</script>.`);
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(html).toContain("<code>\n::: {.note}\nCode affiché.\n:::\n</code>");
  expect(html).not.toContain("Contenu interne supprimé.");
  expect(html).not.toMatch(/class="(?:note|script)"/);
});

it("conserve la portée de l’encadré extérieur quand un délimiteur intérieur est inconnu", async () => {
  const book = await importMarkdown(`# Encadré

::: {.extérieur}
Début.

::: {.intérieur cle=valeur}
Dedans.
:::

Encore extérieur.
:::

Après l’encadré.`);
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(html).toMatch(
    /class="extérieur"[\s\S]+Encore extérieur\.[\s\S]+<\/div>[\s\S]+Après l’encadré\./u,
  );
  expect(html).toContain("::: {.intérieur cle=valeur}");
  expect(book.diagnostics).toEqual([
    { code: "unsupported-container-marker", severity: "warning", count: 1 },
  ]);
});

it("évite de recopier un attribut démesuré à chaque titre d’un conteneur", async () => {
  const longClass = "a".repeat(6_000);
  const titles = Array.from(
    { length: 25 },
    (_, index) => `## Partie ${index}\n\nTexte.`,
  );
  const book = await importMarkdown(
    [`::: {.${longClass}}`, ...titles, ":::"].join("\n\n"),
  );
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(html.split(longClass)).toHaveLength(2);
  expect(book.diagnostics).toEqual([
    { code: "unsupported-container-marker", severity: "warning", count: 1 },
  ]);
});

it("borne l’imbrication en gardant le texte des délimiteurs excédentaires", async () => {
  const levels = 34;
  const book = await importMarkdown(
    [
      "# Profondeur",
      "",
      ...Array.from({ length: levels }, () => "::: {.niveau}"),
      "Un texte profond.",
      ...Array.from({ length: levels }, () => ":::"),
    ].join("\n"),
  );
  const html = book.fragments.map((fragment) => fragment.html).join("");
  expect(html.match(/class="niveau"/g)).toHaveLength(32);
  expect(html.match(/:::/g)).toHaveLength(4);
  expect(html).toContain("Un texte profond.");
  expect(book.diagnostics).toEqual([
    { code: "unmatched-container-marker", severity: "warning", count: 4 },
  ]);
});
