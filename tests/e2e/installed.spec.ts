import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { preview } from "vite";

const title = "Carnet de validation Windows";
const ending = "Le second passage est conservé hors connexion. 山、水.";
const manuscript = `# Premier passage\n\nUne lecture imaginaire.\n\n# Deuxième passage\n\n${ending}`;

async function openProfile(profile: string) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
  });
  try {
    const browser = context.browser();
    assert.ok(browser);
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const browserProcess = processInfo.find(({ type }) => type === "browser");
    assert.ok(browserProcess);
    return { context, cdp, browserPid: browserProcess.id };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function launchWindow(
  context: BrowserContext,
  cdp: CDPSession,
  manifestId: string,
  stage: string,
) {
  // Chrome may return an outer tab target ID, distinct from Playwright's inner page ID.
  const url = `${manifestId}?qa-standalone=${stage}`;
  await cdp.send("PWA.launch", { manifestId, url });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const page = context
      .pages()
      .find((candidate) => !candidate.isClosed() && candidate.url() === url);
    if (page) {
      page.setDefaultTimeout(10_000);
      await page.waitForFunction(
        () => matchMedia("(display-mode: standalone)").matches,
      );
      return page;
    }
    await setTimeout(50);
  }
  throw new Error(`Chrome did not open the installed window for ${stage}`);
}

async function ownWindowId(
  context: BrowserContext,
  cdp: CDPSession,
  page: Page,
) {
  const target = await context.newCDPSession(page);
  try {
    const { targetInfo } = await target.send("Target.getTargetInfo");
    return (
      await cdp.send("Browser.getWindowForTarget", {
        targetId: targetInfo.targetId,
      })
    ).windowId;
  } finally {
    await target.detach();
  }
}

async function checkStorageRequest(page: Page, evidence: TestContext) {
  await page.getByText("Stockage local", { exact: true }).click();
  const status = page.locator("#persistence-status");
  await status.getByText(/Stockage persistant/u).waitFor();
  const before = await page.evaluate(() => navigator.storage.persisted());
  if (!before) {
    await page
      .getByRole("button", { name: "Demander le stockage persistant" })
      .click();
    await status
      .getByText(/^Stockage persistant activé\.$|pas accordé|non confirmé/iu)
      .waitFor();
  }
  const after = await page.evaluate(() => navigator.storage.persisted());
  assert.match(
    (await status.textContent()) ?? "",
    after ? /^Stockage persistant activé\.$/u : /pas accordé|non confirmé/iu,
  );
  evidence.diagnostic(
    `Browser-managed storage persistence: before=${before}; after=${after}`,
  );
}

function libraryBook(page: Page) {
  return page
    .locator("#catalog")
    .getByRole("button", { name: title, exact: true });
}

async function addReadingState(app: Page) {
  await app.getByLabel("Fichier Markdown").setInputFiles({
    name: `${title}.md`,
    mimeType: "text/markdown",
    buffer: Buffer.from(manuscript),
  });
  await app.getByRole("button", { name: "Importer", exact: true }).click();
  await libraryBook(app).click();
  await app.getByLabel("Taille du texte").selectOption("large");
  await app.getByRole("button", { name: "Fragment suivant" }).click();
  await app.getByText(ending, { exact: true }).waitFor();
  await app.getByText("Progression de lecture", { exact: true }).click();
  await app.getByLabel("État de l’ouvrage").selectOption("read");
  await app
    .locator("#reader-progress-state")
    .getByText("Terminé", { exact: true })
    .waitFor();
  await app.getByRole("button", { name: "Retour à la bibliothèque" }).click();
  await app.getByRole("button", { name: "Dernière consultation" }).waitFor();
}

async function checkReadingState(app: Page) {
  await libraryBook(app).waitFor();
  await app.getByRole("button", { name: "Dernière consultation" }).click();
  await app.getByText(ending, { exact: true }).waitFor();
  await app.getByText("Progression de lecture", { exact: true }).click();
  await app
    .locator("#reader-progress-state")
    .getByText("Terminé", { exact: true })
    .waitFor();
  assert.equal(await app.getByLabel("Taille du texte").inputValue(), "large");
  assert.equal(await app.getByLabel("État de l’ouvrage").inputValue(), "read");
}

test(
  "Windows Chrome launches an installed app window offline after the browser process restarts",
  {
    skip:
      process.platform !== "win32" &&
      "Native installation lifecycle runs on Windows only",
    timeout: 45_000,
  },
  async (t) => {
    const base = resolve("work/b05-installed-qa");
    await mkdir(base, { recursive: true });
    const root = await realpath(base);
    const profile = await mkdtemp(join(root, "lifecycle-profile-"));
    const alias = `Blacture QA ${basename(profile).slice(-6)}`;
    const dist = resolve(process.env.BLACTURE_TEST_BUILD_DIR ?? "dist");
    const manifest = JSON.parse(
      await readFile(join(dist, "manifest.webmanifest"), "utf8"),
    ) as Record<string, unknown>;
    const content = JSON.stringify({
      ...manifest,
      name: alias,
      short_name: alias,
    });
    const server = await preview({
      build: { outDir: dist },
      preview: { host: "127.0.0.1", port: 0, strictPort: true },
      plugins: [
        {
          name: "qa-test-installation-name",
          configurePreviewServer(server) {
            server.middlewares.use(
              "/manifest.webmanifest",
              (_request, response) => {
                response.setHeader("Content-Type", "application/manifest+json");
                response.end(content);
              },
            );
          },
        },
      ],
    });
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}/`;
    let session: Awaited<ReturnType<typeof openProfile>> | undefined;
    let installationAttempted = false;
    let uninstalled = false;
    try {
      session = await openProfile(profile);
      const firstPid = session.browserPid;
      const browserTab =
        session.context.pages()[0] ?? (await session.context.newPage());
      browserTab.setDefaultTimeout(10_000);
      await browserTab.goto(origin);
      await browserTab.waitForFunction(() =>
        Boolean(navigator.serviceWorker.controller),
      );
      assert.equal(
        await browserTab.evaluate(
          async () => (await (await fetch("manifest.webmanifest")).json()).name,
        ),
        alias,
      );
      installationAttempted = true;
      await session.cdp.send("PWA.install", {
        manifestId: origin,
        installUrlOrBundleUrl: origin,
      });
      // CDP installation defaults to a tab; choose the normal per-app window mode in the test profile.
      await session.cdp.send("PWA.changeAppUserSettings", {
        manifestId: origin,
        displayMode: "standalone",
      });
      const app = await launchWindow(
        session.context,
        session.cdp,
        origin,
        "initial",
      );
      assert.notEqual(
        await ownWindowId(session.context, session.cdp, browserTab),
        await ownWindowId(session.context, session.cdp, app),
      );
      await app.waitForFunction(() =>
        Boolean(navigator.serviceWorker.controller),
      );
      await checkStorageRequest(app, t);
      await addReadingState(app);

      await session.context.close();
      session = undefined;
      await server.close();
      await assert.rejects(() => fetch(origin));

      session = await openProfile(profile);
      assert.notEqual(session.browserPid, firstPid);
      await session.context.setOffline(true);
      const reopened = await launchWindow(
        session.context,
        session.cdp,
        origin,
        "restart-offline",
      );
      await reopened.waitForFunction(
        () => !navigator.onLine && navigator.serviceWorker.controller !== null,
      );
      await checkReadingState(reopened);
      t.diagnostic(
        `Separate installed window and browser processes ${firstPid} → ${session.browserPid}; local server stopped`,
      );
    } finally {
      try {
        if (installationAttempted) {
          session ??= await openProfile(profile);
          await session.cdp.send("PWA.uninstall", { manifestId: origin });
          uninstalled = true;
          const cleanup = session.cdp;
          await assert.rejects(
            () => cleanup.send("PWA.launch", { manifestId: origin }),
            /PWA\.launch.*(?:failed to launch|not installed|not found)/iu,
          );
        }
      } finally {
        await session?.context.close();
        await server.close();
        if (!installationAttempted || uninstalled) {
          const scratch = await realpath(profile);
          assert.equal(dirname(scratch), root);
          assert.ok(basename(scratch).startsWith("lifecycle-profile-"));
          await rm(scratch, { recursive: true, maxRetries: 3 });
        }
      }
    }
  },
);
