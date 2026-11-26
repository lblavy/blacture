import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { preview, type PreviewServer } from "vite";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR4nGPQja9FQ89O9KAhhlFFAIjAnJFx1hCGAAAAAElFTkSuQmCC";
const validBook = [
  "# Jardin synthétique {#jardin}",
  "Une promenade imaginaire. 道、山、水.",
  `![Croquis synthétique](data:image/png;base64,${png})`,
].join("\n\n");

let server: PreviewServer;
let browser: Browser;
let origin: string;

before(async () => {
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

async function loadImportPage(page: Page): Promise<void> {
  page.setDefaultTimeout(10_000);
  await page.goto(origin);
  await page.getByLabel("Fichier Markdown").waitFor();
}

async function selectMarkdown(
  page: Page,
  title: string,
  buffer: Buffer,
): Promise<void> {
  await page.getByLabel("Fichier Markdown").setInputFiles({
    name: `${title}.md`,
    mimeType: "text/markdown",
    buffer,
  });
}

function catalogBook(page: Page, title: string) {
  return page
    .locator("#catalog")
    .getByRole("button", { name: title, exact: true });
}

async function importSyntheticGarden(page: Page): Promise<void> {
  await selectMarkdown(page, "Jardin synthétique", Buffer.from(validBook));
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  try {
    await catalogBook(page, "Jardin synthétique").waitFor();
  } catch (error) {
    const state = await page.locator("#import-status").textContent();
    const diagnostics = await page.locator("#import-diagnostics").textContent();
    throw new Error(`Import state: ${state ?? ""} ${diagnostics ?? ""}`, {
      cause: error,
    });
  }
}

async function expectImportMessage(page: Page, pattern: RegExp): Promise<void> {
  await page.waitForFunction(
    ({ source, flags }) =>
      new RegExp(source, flags).test(
        document.querySelector("#import-status")?.textContent ?? "",
      ),
    { source: pattern.source, flags: pattern.flags },
  );
}

async function expectGardenFragment(page: Page): Promise<void> {
  await catalogBook(page, "Jardin synthétique").click();
  const proof = page.locator("#fragment-preview");
  await proof
    .getByText("Une promenade imaginaire. 道、山、水.", { exact: true })
    .waitFor();
  const image = proof.getByRole("img", { name: "Croquis synthétique" });
  await image.waitFor();
  const imageLoaded = await image.evaluate(async (element) => {
    const raster = element as HTMLImageElement;
    await raster.decode();
    return raster.naturalWidth > 0 && raster.naturalHeight > 0;
  });
  assert.equal(imageLoaded, true);
}

test("Chrome reopens a saved fragment and its image in a new offline tab", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadImportPage(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

  await importSyntheticGarden(page);
  await page.close();

  await context.setOffline(true);
  const offlinePage = await context.newPage();
  await loadImportPage(offlinePage);
  await expectGardenFragment(offlinePage);
});

test("Chrome imports a fresh Markdown file after launching the PWA shell offline", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const preparationPage = await context.newPage();
  await loadImportPage(preparationPage);
  await preparationPage.waitForFunction(() =>
    Boolean(navigator.serviceWorker.controller),
  );
  await preparationPage.close();

  await context.setOffline(true);
  const page = await context.newPage();
  await loadImportPage(page);
  await page.waitForFunction(
    () => !navigator.onLine && navigator.serviceWorker.controller !== null,
  );
  await importSyntheticGarden(page);
  await expectGardenFragment(page);
});

test("Chrome rejects a standalone HTML file even when the chooser filter is bypassed", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadImportPage(page);
  await importSyntheticGarden(page);

  await page.getByLabel("Fichier Markdown").setInputFiles({
    name: "Document HTML.html",
    mimeType: "text/html",
    buffer: Buffer.from("<h1>Document HTML</h1>\n\n<p>Texte synthétique.</p>"),
  });
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await expectImportMessage(
    page,
    /sélectionne un fichier Markdown \(\.md ou \.markdown\)/iu,
  );
  await page.reload();
  await catalogBook(page, "Jardin synthétique").waitFor();
  assert.equal(await page.locator("#catalog").getByRole("button").count(), 1);
});

test("Chrome keeps the committed catalog intact after a UTF-8 decoding error", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadImportPage(page);
  await importSyntheticGarden(page);

  const malformedUtf8 = Buffer.concat([
    Buffer.from("# Décodage invalide\n\n"),
    Buffer.from([0xc3, 0x28]),
  ]);
  await selectMarkdown(page, "Décodage invalide", malformedUtf8);
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await expectImportMessage(page, /utf-8|encodage|échec|impossible|erreur/iu);
  await page.reload();
  await catalogBook(page, "Jardin synthétique").waitFor();
  assert.equal(await page.locator("#catalog").getByRole("button").count(), 1);
});

test("Chrome can cancel an active import before publishing a catalog entry", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadImportPage(page);
  await importSyntheticGarden(page);
  await selectMarkdown(
    page,
    "Import à annuler",
    Buffer.from("# Import à annuler\n\n" + validBook),
  );

  // Trigger each real button's handler in one turn, before asynchronous work can publish.
  const cancelWasAvailable = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    buttons
      .find((button) => button.textContent?.trim() === "Importer")
      ?.click();
    const cancel = buttons.find(
      (button) => button.textContent?.trim() === "Annuler",
    );
    if (!cancel || cancel.disabled) return false;
    cancel.click();
    return true;
  });
  assert.equal(cancelWasAvailable, true);
  await expectImportMessage(page, /annul/iu);
  await page.reload();
  await catalogBook(page, "Jardin synthétique").waitFor();
  assert.equal(await catalogBook(page, "Import à annuler").count(), 0);
  assert.equal(await page.locator("#catalog").getByRole("button").count(), 1);
});

test("Chrome rolls back an IndexedDB error raised during publication", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await loadImportPage(page);
  await importSyntheticGarden(page);

  // Wait for a real successful write request, then fail the surrounding transaction.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      const request = original.call(this, value, key);
      if (this.name !== "resources") return request;
      IDBObjectStore.prototype.add = original;
      request.addEventListener(
        "success",
        () => {
          document.documentElement.dataset.fixtureTransactionAborted = "true";
          this.transaction.abort();
        },
        { once: true },
      );
      return request;
    };
  });
  const secondBook = validBook.replace(
    "Jardin synthétique",
    "Gazebo synthétique",
  );
  await selectMarkdown(page, "Gazebo synthétique", Buffer.from(secondBook));
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await page.locator('html[data-fixture-transaction-aborted="true"]').waitFor();
  await expectImportMessage(page, /transaction|échec|impossible|erreur/iu);
  await page.reload();
  await catalogBook(page, "Jardin synthétique").waitFor();
  assert.equal(await page.locator("#catalog").getByRole("button").count(), 1);
});

test("Chrome does not fetch illustrative remote URLs supplied by an imported document", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const networkAttempts: string[] = [];
  await context.route("https://blacture-fixture.invalid/**", (route) => {
    networkAttempts.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  await loadImportPage(page);
  const source =
    '# Ressource externe\n\n<img alt="Dessin" src="https://blacture-fixture.invalid/image.png">';
  await selectMarkdown(page, "Ressource externe", Buffer.from(source));
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await expectImportMessage(
    page,
    /arrêté|ressource|externe|refus|impossible|erreur/iu,
  );
  await page
    .locator("#import-diagnostics")
    .getByText(/bloquant.*image absente ou non prise en charge/iu)
    .waitFor();
  assert.equal(await catalogBook(page, "Ressource externe").count(), 0);
  assert.deepEqual(networkAttempts, []);
});
