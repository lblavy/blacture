import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { chromium, type Page } from "playwright-core";
import { preview } from "vite";

const title = "Atlas des jardins sauvegardé";
const markdown = new URL("../fixtures/b02/editorial.md", import.meta.url);
const backupMimeType = "application/octet-stream";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAIAAABChommAAAAFUlEQVR4nGPQja9FQ89O9KAhhlFFAIjAnJFx1hCGAAAAAElFTkSuQmCC";
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function catalogBook(page: Page) {
  return page.locator("#catalog").getByRole("button", {
    name: title,
    exact: true,
  });
}

async function browserOnLoopback(t: TestContext) {
  const server = await preview({
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  t.after(() => server.close());
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ channel: "chrome" });
  t.after(() => browser.close());
  return { origin, browser };
}

async function openLibrary(page: Page, origin: string) {
  page.setDefaultTimeout(10_000);
  await page.goto(origin);
  await page.getByLabel("Fichier Markdown").waitFor();
}

async function openBackupPanel(page: Page) {
  await page.getByText("Sauvegarde locale", { exact: true }).click();
}

async function importAndMarkRead(page: Page) {
  await page.getByLabel("Fichier Markdown").setInputFiles({
    name: `${title}.md`,
    mimeType: "text/markdown",
    buffer: await readFile(markdown),
  });
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await catalogBook(page).click();
  await page.getByText("Progression de lecture", { exact: true }).click();
  await page.getByLabel("État de la section").selectOption("read");
  await page.locator("#reader-section-progress").getByText("Terminé").waitFor();
  await page.getByRole("button", { name: "Retour à la bibliothèque" }).click();
}

async function selectArchive(page: Page, filename: string, bytes: Buffer) {
  await page.getByLabel("Fichier de sauvegarde").setInputFiles({
    name: filename,
    mimeType: backupMimeType,
    buffer: bytes,
  });
}

function restoreButton(page: Page) {
  return page.getByRole("button", { name: "Restaurer l’ouvrage", exact: true });
}

async function expectReadSection(page: Page) {
  const progressPanel = page.getByText("Progression de lecture", {
    exact: true,
  });
  if (!(await page.getByLabel("État de la section").isVisible()))
    await progressPanel.click();
  const progress = page.locator("#reader-section-progress");
  await progress.getByText("Terminé").waitFor();
  assert.equal(
    await page.getByLabel("État de la section").inputValue(),
    "read",
  );
}

async function respondToRemoval(page: Page, confirm: boolean) {
  const response = page.waitForEvent("dialog").then(async (dialog) => {
    const type = dialog.type();
    const message = dialog.message();
    if (confirm) await dialog.accept();
    else await dialog.dismiss();
    return { type, message };
  });
  const [dialog] = await Promise.all([
    response,
    page.getByRole("button", { name: "Retirer de cet appareil" }).click(),
  ]);
  assert.equal(dialog.type, "confirm");
  assert.ok(dialog.message.includes(title));
  assert.match(dialog.message, /progression locale/iu);
}

async function expectLoadedImage(page: Page, name: string) {
  const image = page.getByRole("img", { name, exact: true });
  await image.waitFor();
  const loaded = await image.evaluate(async (element) => {
    const raster = element as HTMLImageElement;
    await raster.decode();
    return raster.naturalWidth > 0 && raster.naturalHeight > 0;
  });
  assert.equal(loaded, true);
}

test(
  "Chrome restores an offline backup to a clean profile and rejects damaged and duplicate archives",
  {
    timeout: 60_000,
  },
  async (t) => {
    const { origin, browser } = await browserOnLoopback(t);

    const source = await browser.newContext({ acceptDownloads: true });
    const page = await source.newPage();
    await openLibrary(page, origin);
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await importAndMarkRead(page);

    await source.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);
    await openBackupPanel(page);
    await page
      .getByLabel("Ouvrage à sauvegarder")
      .selectOption({ label: title });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Exporter la sauvegarde" }).click(),
    ]);
    assert.match(download.suggestedFilename(), /\.blacture$/u);
    const bytes = await readFile(await download.path());
    assert.ok(bytes.includes(pngSignature));

    const destination = await browser.newContext();
    const checkingPage = await destination.newPage();
    await openLibrary(checkingPage, origin);
    await checkingPage.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await destination.setOffline(true);
    await checkingPage.waitForFunction(() => !navigator.onLine);
    await openBackupPanel(checkingPage);
    const status = checkingPage.locator("#backup-status");
    await selectArchive(checkingPage, download.suggestedFilename(), bytes);
    await checkingPage
      .getByRole("button", { name: "Vérifier la sauvegarde" })
      .click();
    await status
      .getByText(/Intégrité vérifiée .+Données de progression présentes/iu)
      .waitFor();
    assert.equal(await catalogBook(checkingPage).count(), 0);

    const damagedBytes = Buffer.from(bytes);
    const changedByte = Math.floor(damagedBytes.length / 2);
    damagedBytes[changedByte] = damagedBytes[changedByte]! ^ 1;
    await selectArchive(
      checkingPage,
      "Archive de contrôle.blacture",
      damagedBytes,
    );
    await restoreButton(checkingPage).click();
    await status
      .getByText(/invalide|endommag|corrompu|altér|impossible|échec/iu)
      .waitFor();
    assert.equal(await catalogBook(checkingPage).count(), 0);

    await selectArchive(checkingPage, download.suggestedFilename(), bytes);
    await restoreButton(checkingPage).click();
    await catalogBook(checkingPage).waitFor();
    await status.getByText(/restauré|restauration terminée/iu).waitFor();
    await selectArchive(checkingPage, download.suggestedFilename(), bytes);
    await restoreButton(checkingPage).click();
    await status
      .getByText(/déjà (présent|dans|existant)|figure déjà/iu)
      .waitFor();
    assert.equal(await catalogBook(checkingPage).count(), 1);

    await checkingPage.close();
    const restoredPage = await destination.newPage();
    await openLibrary(restoredPage, origin);
    await catalogBook(restoredPage).click();
    await expectReadSection(restoredPage);
    await restoredPage
      .getByRole("button", { name: "Fragment suivant" })
      .click();
    await expectLoadedImage(restoredPage, "Croquis du jardin");

    await page.reload();
    await catalogBook(page).click();
    await expectReadSection(page);
  },
);

test(
  "Chrome replaces a book once, keeps reliable progress and lets the reader recover the previous edition",
  { timeout: 60_000 },
  async (t) => {
    const { origin, browser } = await browserOnLoopback(t);
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await openLibrary(page, origin);
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await context.setOffline(true);
    await page.waitForFunction(() => !navigator.onLine);

    const stable =
      "# Découverte du jardin {#decouverte}\n\nLa haie fruitière longe la prairie.";
    const oldPassage = "L’ancienne passerelle traverse la mare.";
    const newPassage = "Un nouveau sentier contourne la mare.";
    const previousEdition = [
      stable,
      "# Passerelle {#passerelle}",
      oldPassage,
      `![Dessin de la passerelle](data:image/png;base64,${png})`,
    ].join("\n\n");
    const nextEdition = `${stable}\n\n# Nouveau sentier {#sentier}\n\n${newPassage}`;
    const input = page.getByLabel("Fichier Markdown");
    const catalogue = page.locator("#catalog");
    const importStatus = page.locator("#import-status");
    const backToLibrary = page.getByRole("button", {
      name: "Retour à la bibliothèque",
    });
    async function selectMarkdown(contents: string) {
      await input.setInputFiles({
        name: `${title}.md`,
        mimeType: "text/markdown",
        buffer: Buffer.from(contents),
      });
    }

    await selectMarkdown(previousEdition);
    await page.getByRole("button", { name: "Importer", exact: true }).click();
    const previousKey = await catalogBook(page).getAttribute("data-book-key");
    assert.ok(previousKey);
    await catalogBook(page).click();
    await page.getByText("Progression de lecture", { exact: true }).click();
    await page.getByLabel("État de la section").selectOption("read");
    await page
      .locator("#reader-section-progress")
      .getByText("Terminé")
      .waitFor();
    await backToLibrary.click();

    await selectMarkdown(nextEdition);
    await page.locator("#import-replacement").selectOption({ label: title });
    await page
      .getByRole("button", { name: "Remplacer l’ouvrage", exact: true })
      .click();
    await importStatus.getByText(/Ouvrage remplacé/iu).waitFor();
    await page.waitForFunction((oldKey) => {
      const entries = document.querySelectorAll<HTMLButtonElement>(
        '#catalog button[data-book-action="open"]',
      );
      return entries.length === 1 && entries[0]?.dataset.bookKey !== oldKey;
    }, previousKey);
    assert.equal(
      await catalogue.getByRole("button", { name: title, exact: true }).count(),
      1,
    );
    await selectMarkdown(nextEdition);
    await page.getByRole("button", { name: "Importer", exact: true }).click();
    await importStatus.getByText("Import terminé.", { exact: true }).waitFor();
    assert.equal(
      await catalogue.locator('button[data-book-action="open"]').count(),
      1,
    );
    await catalogBook(page).click();
    const progressPanel = page.getByText("Progression de lecture", {
      exact: true,
    });
    if (!(await page.getByLabel("État de la section").isVisible()))
      await progressPanel.click();
    await page
      .locator("#reader-section-progress")
      .getByText("Terminé")
      .waitFor();
    assert.equal(
      await page.getByLabel("État de la section").inputValue(),
      "read",
    );
    await page.getByRole("button", { name: "Fragment suivant" }).click();
    await page
      .locator("#fragment-preview")
      .getByText(newPassage, { exact: true })
      .waitFor();
    await page
      .locator("#reader-section-progress")
      .getByText("Non commencé")
      .waitFor();
    assert.equal(
      await page.getByLabel("État de la section").inputValue(),
      "auto",
    );
    await backToLibrary.click();

    await openBackupPanel(page);
    await page
      .getByLabel("Ouvrage à sauvegarder")
      .selectOption({ label: title });
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("button", { name: "Exporter l’édition précédente" })
        .click(),
    ]);
    assert.match(download.suggestedFilename(), /\.blacture$/u);
    const archive = await readFile(await download.path());
    assert.ok(archive.includes(pngSignature));
    await respondToRemoval(page, false);
    assert.equal(
      await catalogue.locator('button[data-book-action="open"]').count(),
      1,
    );
    await page
      .getByRole("button", { name: "Exporter l’édition précédente" })
      .waitFor();
    await respondToRemoval(page, true);
    await page
      .locator("#backup-status")
      .getByText(/retiré de cet appareil/iu)
      .waitFor();
    await catalogBook(page).waitFor({ state: "detached" });

    await selectArchive(page, download.suggestedFilename(), archive);
    await restoreButton(page).click();
    assert.equal(
      await catalogBook(page).getAttribute("data-book-key"),
      previousKey,
    );
    await catalogBook(page).click();
    await expectReadSection(page);
    await page.getByRole("button", { name: "Fragment suivant" }).click();
    await page
      .locator("#fragment-preview")
      .getByText(oldPassage, { exact: true })
      .waitFor();
    await expectLoadedImage(page, "Dessin de la passerelle");
  },
);
