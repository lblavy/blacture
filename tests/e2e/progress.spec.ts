import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { preview, type PreviewServer } from "vite";

let server: PreviewServer;
let browser: Browser;
let origin: string;

before(async () => {
  server = await preview({
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}/`;
  browser = await chromium.launch({ channel: "chrome" });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

function book(page: Page, title: string) {
  return page
    .locator("#catalog")
    .getByRole("button", { name: title, exact: true });
}

function reading(page: Page) {
  return page.getByRole("article", { name: "Contenu de l’ouvrage" });
}

async function importBook(page: Page, title: string, source: string) {
  page.setDefaultTimeout(10_000);
  await page.clock.install({ time: new Date("2026-01-01T08:00:00Z") });
  await page.goto(origin);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.getByLabel("Fichier Markdown").setInputFiles({
    name: `${title}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(source),
  });
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await book(page, title).waitFor();
}

async function expandDetail(page: Page, id: string) {
  const details = page.locator(id);
  if ((await details.getAttribute("open")) === null) {
    await details.locator("summary").first().click();
  }
  return details;
}

async function centerPassage(page: Page, text: string, fraction = 0.5) {
  const paragraph = reading(page).getByText(text, { exact: true });
  await paragraph.waitFor();
  // Preserve native layout and scrolling while letting even the first block reach the center.
  await paragraph.evaluate((element, position) => {
    const article = element.closest<HTMLElement>("article");
    if (!article) throw new Error("Reader article missing");
    article.style.paddingBlock = "60vh";
    element.scrollIntoView({ block: "center" });
    const toolbar = document.querySelector(".reader-toolbar");
    const occupied = Math.max(0, toolbar?.getBoundingClientRect().bottom ?? 0);
    const passage = element.getBoundingClientRect();
    window.scrollBy(
      0,
      passage.top +
        passage.height * position -
        (occupied + window.innerHeight) / 2,
    );
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, fraction);
}

async function expectSectionState(page: Page, expected: RegExp) {
  await page.waitForFunction(
    ({ pattern, flags }) => {
      const summary = document.querySelector("#reader-section-progress");
      return new RegExp(pattern, flags).test(summary?.textContent ?? "");
    },
    { pattern: expected.source, flags: expected.flags },
  );
}

async function showProgress(page: Page) {
  await expandDetail(page, "#reader-progress");
}

async function openChapterSeven(page: Page) {
  const outline = await expandDetail(page, "#reader-toc-panel");
  const group = outline.getByLabel(
    "Sous-sections de Ensemble des chapitres 1 à 29",
    { exact: true },
  );
  if ((await group.locator("xpath=..").getAttribute("open")) === null)
    await group.click();
  await outline.getByRole("button", { name: /^Chapitre 7\b/u }).click();
}

async function setSectionMode(page: Page, mode: "auto" | "read" | "unread") {
  await showProgress(page);
  await page.getByLabel("État de la section").selectOption(mode);
}

async function setPresence(page: Page, present: boolean) {
  await page.evaluate((active) => {
    // Chromium headless keeps tabs visible and focused; exercise the browser lifecycle events with a fixture.
    if (active) {
      for (const name of ["hidden", "visibilityState", "hasFocus"])
        Reflect.deleteProperty(document, name);
    } else {
      Object.defineProperties(document, {
        hidden: { configurable: true, value: true },
        visibilityState: { configurable: true, value: "hidden" },
        hasFocus: { configurable: true, value: () => false },
      });
    }
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event(active ? "focus" : "blur"));
  }, present);
}

test("Chrome separates the last consultation in chapter 7 from the first unread block in 30", async (t) => {
  const context = await browser.newContext({
    viewport: { width: 900, height: 760 },
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const title = "Ouvrage synthétique en trente chapitres";
  const first = "Premier passage déjà lu du chapitre 30.";
  const unread = "Deuxième passage encore à lire du chapitre 30.";
  const chapterSeven = "Passage consulté au chapitre 7.";
  const firstChapters = Array.from({ length: 29 }, (_, index) => {
    const n = index + 1;
    return `## Chapitre ${n}\n\nPassage consulté au chapitre ${n}.`;
  });
  const source = [
    "# Ensemble des chapitres 1 à 29",
    ...firstChapters,
    "# Chapitre 30",
    first,
    unread,
    "Troisième passage du chapitre 30.",
  ].join("\n\n");

  await importBook(page, title, source);
  await book(page, title).click();
  await reading(page)
    .getByRole("heading", { name: "Ensemble des chapitres 1 à 29" })
    .waitFor();
  await setSectionMode(page, "read");
  await expectSectionState(page, /terminé/iu);

  const outline = await expandDetail(page, "#reader-toc-panel");
  await outline.getByRole("button", { name: /^Chapitre 30\b/u }).click();
  await centerPassage(page, first);
  await page.clock.runFor(9_600);
  await expectSectionState(page, /en cours/iu);

  await openChapterSeven(page);
  await centerPassage(page, chapterSeven);
  await page.clock.runFor(1_200);
  await expectSectionState(page, /terminé/iu);
  const back = page.getByRole("button", { name: "Retour à la bibliothèque" });
  await back.click();

  const actions = book(page, title).locator("xpath=ancestor::li[1]");
  await actions.getByRole("button", { name: "Dernière consultation" }).click();
  await reading(page).getByText(chapterSeven, { exact: true }).waitFor();
  await back.click();
  await actions
    .getByRole("button", { name: "Continuer ma progression" })
    .click();
  await reading(page).getByText(unread, { exact: true }).waitFor();
  await page.waitForFunction(
    (text) => document.activeElement?.textContent === text,
    unread,
  );

  await openChapterSeven(page);
  await reading(page).getByText(chapterSeven, { exact: true }).waitFor();
  await setSectionMode(page, "unread");
  await expectSectionState(page, /non commencé/iu);
  await back.click();
  await actions
    .getByRole("button", { name: "Continuer ma progression" })
    .click();
  await reading(page).getByText(chapterSeven, { exact: true }).waitFor();
});

test("Chrome accrues active dwell cumulatively and keeps a manual override across offline reopening", async (t) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const title = "Carnet synthétique de la lanterne";
  const passage = "Le veilleur remarque une lanterne au milieu du jardin.";
  await importBook(page, title, `# Lanterne\n\n${passage}`);
  await book(page, title).click();
  await showProgress(page);
  await centerPassage(page, passage);
  const incomplete = /non commencé|en cours/iu;

  await page.clock.runFor(6_000);
  await expectSectionState(page, incomplete);
  await setPresence(page, false);
  await page.clock.runFor(12_000);
  await expectSectionState(page, incomplete);
  await setPresence(page, true);
  await page.clock.runFor(4_500);
  await expectSectionState(page, /terminé/iu);

  await page.getByRole("button", { name: "Retour à la bibliothèque" }).click();
  const completedEntry = book(page, title).locator("xpath=ancestor::li[1]");
  await completedEntry.getByText(/terminé/iu).waitFor();
  const resume = completedEntry.getByRole("button", {
    name: "Continuer ma progression",
  });
  if (await resume.count()) assert.ok(await resume.isDisabled());
  await book(page, title).click();
  await reading(page).getByText(passage, { exact: true }).waitFor();
  await showProgress(page);

  await page.getByLabel("Taille du texte").selectOption("large");
  await expectSectionState(page, /terminé/iu);
  await page.getByLabel("État de l’ouvrage").selectOption("unread");
  await expectSectionState(page, /non commencé/iu);
  await centerPassage(page, passage);
  await page.clock.runFor(9_600);
  await expectSectionState(page, /non commencé/iu);

  const route = page.url();
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  reopened.setDefaultTimeout(10_000);
  await reopened.goto(route);
  await reopened.waitForFunction(
    () => !navigator.onLine && navigator.serviceWorker.controller !== null,
  );
  await reading(reopened).getByText(passage, { exact: true }).waitFor();
  await showProgress(reopened);
  await expectSectionState(reopened, /non commencé/iu);
  assert.equal(
    await reopened.getByLabel("État de l’ouvrage").inputValue(),
    "unread",
  );
  assert.equal(
    await reopened.getByLabel("État de la section").inputValue(),
    "unread",
  );
  assert.equal(
    await reopened.getByLabel("Taille du texte").inputValue(),
    "large",
  );

  await reopened.getByLabel("État de l’ouvrage").selectOption("auto");
  await expectSectionState(reopened, /terminé/iu);
});

test("Chrome keeps a tall passage incomplete after a scroll jump until all four bands were visible", async (t) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const title = "Carnet synthétique du ciel";
  const passage = "Une lueur persiste derrière la longue ligne de nuages. "
    .repeat(230)
    .trim();
  await importBook(page, title, `# Horizon\n\n${passage}`);
  await book(page, title).click();
  await showProgress(page);
  const incomplete = /non commencé|en cours/iu;

  await centerPassage(page, passage, 0.125);
  await page.clock.runFor(9_600);
  await expectSectionState(page, incomplete);

  await centerPassage(page, passage, 0.875);
  await page.clock.runFor(2_300);
  await expectSectionState(page, incomplete);

  await centerPassage(page, passage, 0.375);
  await page.clock.runFor(2_300);
  await expectSectionState(page, incomplete);

  await centerPassage(page, passage, 0.625);
  await page.clock.runFor(2_300);
  await expectSectionState(page, /terminé/iu);
});
