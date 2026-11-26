import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { preview, type PreviewServer } from "vite";

const atlas = "Atlas synthétique des belvédères";
const east = "Jardin de l’est";
const west = "Jardin de l’ouest";
const terraceText =
  "Depuis la terrasse haute, on distingue les montagnes 山 et la rivière 水.";
const fixturePath = new URL("../fixtures/b03/belvederes.md", import.meta.url);

let server: PreviewServer;
let browser: Browser;
let origin: string;
let atlasSource: Buffer;

before(async () => {
  atlasSource = await readFile(fixturePath);
  server = await preview({
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: "chrome" });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

function book(page: Page, name: string) {
  return page.locator("#catalog").getByRole("button", { name, exact: true });
}

function reading(page: Page) {
  return page.getByRole("article", { name: "Contenu de l’ouvrage" });
}

async function loadShell(page: Page, url = origin) {
  page.setDefaultTimeout(10_000);
  await page.goto(url);
}

async function importBook(page: Page, title: string, source: Buffer) {
  await page.getByLabel("Fichier Markdown").setInputFiles({
    name: `${title}.md`,
    mimeType: "text/markdown",
    buffer: source,
  });
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  try {
    await book(page, title).waitFor();
  } catch (error) {
    const status = await page.locator("#import-status").textContent();
    const diagnostics = await page.locator("#import-diagnostics").textContent();
    throw new Error(`Import state: ${status ?? ""} ${diagnostics ?? ""}`, {
      cause: error,
    });
  }
}

async function openOutline(page: Page) {
  const toc = page.locator("#reader-toc-panel");
  if ((await toc.getAttribute("open")) === null) {
    await toc.getByText("Sommaire", { exact: true }).click();
  }
  return toc;
}

async function checkImageLoaded(page: Page, altText: string) {
  const image = reading(page).getByRole("img", { name: altText });
  await image.waitFor();
  const width = await image.evaluate(async (element) => {
    const raster = element as HTMLImageElement;
    await raster.decode();
    return raster.naturalWidth;
  });
  assert.ok(width > 0);
}

test("Chrome selects independent books and navigates a nested outline in canonical order", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadShell(page);
  await importBook(page, atlas, atlasSource);
  const other = "Récit sans sommaire";
  await importBook(
    page,
    other,
    Buffer.from("Un autre récit, sans un seul titre interne."),
  );
  await book(page, other).click();
  await reading(page)
    .getByText("Un autre récit, sans un seul titre interne.")
    .waitFor();
  await page.getByRole("button", { name: "Retour à la bibliothèque" }).click();

  await book(page, atlas).click();
  await reading(page).getByText("Préface du carnet des belvédères.").waitFor();
  const previous = page.getByRole("button", { name: "Fragment précédent" });
  const next = page.getByRole("button", { name: "Fragment suivant" });
  assert.ok(await previous.isDisabled());

  await next.click();
  await reading(page)
    .getByText(/le jardin de l’est possède un texte propre/iu)
    .waitFor();
  await next.click();
  await reading(page)
    .getByText("On traverse le passage de l’est avant de monter.")
    .waitFor();
  await previous.click();
  await reading(page)
    .getByText(/le jardin de l’est possède un texte propre/iu)
    .waitFor();

  const outline = await openOutline(page);
  const eastChildren = outline.getByLabel(`Sous-sections de ${east}`, {
    exact: true,
  });
  const westChildren = outline.getByLabel(`Sous-sections de ${west}`, {
    exact: true,
  });
  const eastBranch = eastChildren.locator("xpath=..");
  const westBranch = westChildren.locator("xpath=..");
  assert.equal(
    await eastBranch
      .getByRole("button", { name: "Passage", exact: true })
      .count(),
    0,
  );
  await eastChildren.click();
  const eastPassage = eastBranch.getByRole("button", {
    name: "Passage",
    exact: true,
  });
  await eastPassage.waitFor();
  await eastChildren.click();
  await eastPassage.waitFor({ state: "hidden" });
  await westChildren.click();
  const westPassage = westBranch.getByRole("button", {
    name: "Passage",
    exact: true,
  });
  await westPassage.click();
  await reading(page)
    .getByText("Au passage de l’ouest, les pierres sont sombres.")
    .waitFor();
  await next.click();
  await reading(page)
    .getByText(/le balcon était autrefois un observatoire/iu)
    .waitFor();
  assert.ok(await next.isDisabled());
});

async function watchFragmentReads(page: Page) {
  await page.evaluate(() => {
    const names = ["fragments", "resources"];
    const original = IDBObjectStore.prototype.get;
    const originalAll = IDBObjectStore.prototype.getAll;
    const root = document.documentElement;
    const record = (store: string, method: string) => {
      if (names.includes(store)) {
        root.dataset.readerReads = `${root.dataset.readerReads ?? ""}${store}:${method} `;
      }
    };
    IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
      record(this.name, "get");
      return original.call(this, query);
    };
    IDBObjectStore.prototype.getAll = function (query, count) {
      record(this.name, "getAll");
      return originalAll.call(this, query, count);
    };
  });
  return async () =>
    (await page.locator("html").getAttribute("data-reader-reads"))
      ?.trim()
      .split(/\s+/u) ?? [];
}

test("Chrome resolves note links and returns with only on-demand fragment and resource reads", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadShell(page);
  await importBook(page, atlas, atlasSource);
  const reads = await watchFragmentReads(page);
  await book(page, atlas).click();
  await reading(page).getByText("Préface du carnet des belvédères.").waitFor();
  assert.deepEqual(await reads(), ["fragments:get"]);

  await page.getByRole("button", { name: "Fragment suivant" }).click();
  await checkImageLoaded(page, "Croquis du jardin de l’est");
  assert.deepEqual(await reads(), [
    "fragments:get",
    "fragments:get",
    "resources:get",
  ]);

  const reference = reading(page).getByRole("link", { name: "Note du balcon" });
  await reference.click();
  const noteText = reading(page).getByText(
    /le balcon était autrefois un observatoire/iu,
  );
  await noteText.waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes(
      "Le balcon était autrefois un observatoire",
    ),
  );
  assert.deepEqual(await reads(), [
    "fragments:get",
    "fragments:get",
    "resources:get",
    "fragments:get",
  ]);
  await page.getByRole("button", { name: "Retour au passage" }).click();
  await reference.waitFor();
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Note du balcon",
  );
  await reference.click();
  await reading(page)
    .getByRole("link", { name: "Renvoyer vers l’appel du balcon" })
    .click();
  await reference.waitFor();
  await page
    .getByRole("button", { name: "Retour au passage" })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Note du balcon",
  );
  await checkImageLoaded(page, "Croquis du jardin de l’est");
  assert.equal(
    await reading(page)
      .getByRole("img", { name: "Croquis du jardin de l’ouest" })
      .count(),
    0,
  );
});

async function checkFocusedTitleBelowToolbar(page: Page) {
  await page.waitForFunction(
    () => document.activeElement?.id === "reader-title",
  );
  const layout = await page.evaluate(() => ({
    titleTop: document.activeElement!.getBoundingClientRect().top,
    toolbarBottom: document
      .querySelector(".reader-toolbar")!
      .getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  assert.ok(
    layout.titleTop >= layout.toolbarBottom - 1 &&
      layout.titleTop < layout.viewportHeight,
    `Focused title is outside the visible reading area: ${JSON.stringify(layout)}`,
  );
}

test("Chrome with a touch viewport reloads the current route and font size in a new offline tab", async (t) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  await loadShell(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const prolongedPreface = Array.from(
    { length: 24 },
    (_, index) =>
      `Paragraphe de repérage ${index + 1}. Le promeneur note des détails sur le paysage et attend le prochain rayon de soleil.`,
  ).join("\n\n");
  await importBook(
    page,
    atlas,
    Buffer.concat([Buffer.from(`${prolongedPreface}\n\n`), atlasSource]),
  );
  await book(page, atlas).tap();
  await reading(page).getByText("Préface du carnet des belvédères.").waitFor();
  await checkFocusedTitleBelowToolbar(page);

  await page.getByRole("button", { name: "Fragment suivant" }).tap();
  await reading(page)
    .getByText(/le jardin de l’est possède un texte propre/iu)
    .waitFor();
  await checkFocusedTitleBelowToolbar(page);
  const outline = await openOutline(page);
  await outline.getByLabel(`Sous-sections de ${east}`, { exact: true }).tap();
  await outline.getByLabel("Sous-sections de Passage", { exact: true }).tap();
  await outline
    .getByRole("button", { name: "Terrasse haute", exact: true })
    .tap();

  const text = reading(page).getByText(terraceText, { exact: true });
  await text.waitFor();
  assert.ok(await reading(page).getByRole("table").isVisible());
  const fontSize = page.locator("#reader-font-size");
  const sizeBefore = await text.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  await fontSize.selectOption("large");
  await page.waitForFunction((baseline) => {
    const article = document.querySelector("#fragment-preview");
    return (
      article !== null &&
      Number.parseFloat(getComputedStyle(article).fontSize) > baseline
    );
  }, sizeBefore);

  const route = page.url();
  assert.notEqual(route, `${origin}/`);
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  );
  await page.close();

  await context.setOffline(true);
  const reopened = await context.newPage();
  await loadShell(reopened, route);
  await reopened.waitForFunction(
    () => !navigator.onLine && navigator.serviceWorker.controller !== null,
  );
  const restored = reading(reopened).getByText(terraceText, { exact: true });
  await restored.waitFor();
  assert.equal(
    await reopened.locator("#reader-font-size").inputValue(),
    "large",
  );
  assert.ok(
    (await restored.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    )) > sizeBefore,
  );
});

async function seedLegacyCatalog(page: Page, title: string) {
  const raster = /data:image\/png;base64,([A-Za-z0-9+/=]+)/u.exec(
    atlasSource.toString("utf8"),
  )?.[1];
  assert.ok(raster);
  const bytes = Array.from(Buffer.from(raster, "base64"));

  // Give the native IndexedDB API the real origin before loading any B03 code.
  await page.route(
    `${origin}/`,
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Legacy catalog fixture</title>",
      }),
    { times: 1 },
  );
  await loadShell(page);
  await page.evaluate(
    async ({ title: name, bytes: rasterBytes }) => {
      const stores = ["catalog", "manifests", "fragments", "resources"];
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("blacture-library", 1);
        request.onupgradeneeded = () => {
          for (const store of stores) request.result.createObjectStore(store);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const workId = "legacy-catalog-work";
      const editionId = "legacy-catalog-edition";
      const key = JSON.stringify([workId, editionId]);
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction(stores, "readwrite");
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
          tx.objectStore("catalog").add(
            {
              key,
              title: name,
              firstFragmentId: "legacy-first",
              resourceBytes: rasterBytes.length,
            },
            key,
          );
          tx.objectStore("manifests").add(
            {
              schemaVersion: 1,
              workId,
              editionId,
              title: name,
              sections: [
                {
                  id: "s-first",
                  parentId: null,
                  title: "Section ancienne",
                  level: 1,
                  fragmentIds: ["legacy-first"],
                },
                {
                  id: "s-absent",
                  parentId: null,
                  title: "Section absente",
                  level: 1,
                  fragmentIds: ["legacy-absent"],
                },
              ],
              destinations: {},
              diagnostics: [],
            },
            key,
          );
          tx.objectStore("fragments").add(
            {
              id: "legacy-first",
              sectionId: "s-first",
              blockIds: ["legacy-line"],
              resourceIds: ["legacy-png"],
              html: '<p data-block-id="legacy-line">Texte conservé de B02.</p><img alt="Dessin ancien" data-resource-id="legacy-png">',
            },
            [key, "legacy-first"],
          );
          tx.objectStore("resources").add(
            {
              id: "legacy-png",
              mimeType: "image/png",
              bytes: new Uint8Array(rasterBytes),
            },
            [key, "legacy-png"],
          );
        });
      } finally {
        database.close();
      }
    },
    { title, bytes },
  );
}

test("Chrome reads a B02 library database and recovers from an unavailable fragment", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const name = "Carnet importé par B02";
  await seedLegacyCatalog(page, name);
  await loadShell(page);
  await book(page, name).click();
  await reading(page)
    .getByText("Texte conservé de B02.", { exact: true })
    .waitFor();
  await checkImageLoaded(page, "Dessin ancien");

  const outline = await openOutline(page);
  await outline.getByRole("button", { name: "Section absente" }).click();
  await page
    .locator("#reader-status")
    .getByText(/introuvable|indisponible|impossible|absent/iu)
    .waitFor();
  await page.getByRole("button", { name: "Retour à la bibliothèque" }).click();
  await book(page, name).click();
  await reading(page)
    .getByText("Texte conservé de B02.", { exact: true })
    .waitFor();
});
