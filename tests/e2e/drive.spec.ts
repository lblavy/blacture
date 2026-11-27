import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright-core";
import { build, preview } from "vite";

const bookTitle = "Carnet synthétique Drive";
const markdown = `# ${bookTitle}

Un premier passage de test.

# Deuxième passage

Un deuxième passage de test.`;
const accountId = "synthetic-account";
const consentMock = `window.google={accounts:{oauth2:{initTokenClient(config){
 if(config.scope!=="https://www.googleapis.com/auth/drive.file"||config.include_granted_scopes){
  throw new Error("Unexpected OAuth scope");
 }
 return { requestAccessToken() { config.callback({
  access_token:"fake-browser-token",expires_in:3600,scope:config.scope
 }) }};
}}}};`;

type Descriptor = { id: string; name: string; appProperties: { kind: string } };

function googleFixture(origin: string) {
  const files = new Map<string, { metadata: Descriptor; body: Buffer }>();
  const pending = new Map<string, Descriptor>();
  let nextId = 0;
  let expire = false;
  const headers = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,content-range,x-upload-content-type,x-upload-content-length",
    "access-control-expose-headers": "Location,Range",
  };
  const describe = ({
    metadata,
    body,
  }: {
    metadata: Descriptor;
    body: Buffer;
  }) => ({ ...metadata, size: String(body.length) });

  async function upload(route: Route, url: URL, method: string) {
    if (method === "POST") {
      const metadata = route.request().postDataJSON() as Descriptor;
      if (files.has(metadata.id))
        return route.fulfill({ status: 409, headers });
      pending.set(metadata.id, metadata);
      const location = new URL(url.origin + url.pathname);
      location.searchParams.set("upload_id", metadata.id);
      return route.fulfill({
        headers: { ...headers, location: location.href },
      });
    }
    const id = url.searchParams.get("upload_id") ?? "";
    const completed = files.get(id);
    if (completed) return route.fulfill({ headers, json: describe(completed) });
    const metadata = pending.get(id);
    if (!metadata) return route.fulfill({ headers, status: 404 });
    const range = route.request().headers()["content-range"] ?? "";
    if (range.startsWith("bytes */"))
      return route.fulfill({ headers, status: 308 });
    if (expire && metadata.appProperties.kind === "progress") {
      expire = false;
      return route.fulfill({ headers, status: 401 });
    }
    const body = route.request().postDataBuffer();
    assert.ok(body);
    assert.equal(range, `bytes 0-${body.length - 1}/${body.length}`);
    files.set(id, { metadata, body });
    pending.delete(id);
    return route.fulfill({ headers, json: describe({ metadata, body }) });
  }

  async function handle(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers });
    assert.equal(
      request.headers()["authorization"],
      "Bearer fake-browser-token",
    );
    if (url.pathname === "/upload/drive/v3/files")
      return upload(route, url, method);
    if (url.pathname === "/drive/v3/about")
      return route.fulfill({
        headers,
        json: { user: { permissionId: accountId } },
      });
    if (url.pathname === "/drive/v3/files/generateIds")
      return route.fulfill({
        headers,
        json: { ids: [`synthetic_${++nextId}`] },
      });
    if (url.pathname === "/drive/v3/files")
      return route.fulfill({
        headers,
        json: { files: [...files.values()].map(describe) },
      });
    const file = files.get(url.pathname.split("/").at(-1) ?? "");
    if (!file) return route.fulfill({ headers, status: 404 });
    return url.searchParams.get("alt") === "media"
      ? route.fulfill({
          headers,
          body: file.body,
          contentType: "application/octet-stream",
        })
      : route.fulfill({ headers, json: describe(file) });
  }
  async function attach(context: BrowserContext) {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      if (url.href === "https://accounts.google.com/gsi/client")
        return route.fulfill({
          contentType: "application/javascript",
          body: consentMock,
        });
      if (url.origin === "https://www.googleapis.com") return handle(route);
      return route.abort();
    });
  }
  return {
    attach,
    expireNextProgressUpload() {
      expire = true;
    },
    editions() {
      return [...files.values()].filter(
        ({ metadata }) => metadata.appProperties.kind === "edition",
      ).length;
    },
  };
}

async function connect(page: Page) {
  await page.getByText("Google Drive", { exact: true }).click();
  await page
    .getByRole("button", { name: "Connecter Google Drive", exact: true })
    .click();
  await page
    .locator("#drive-status")
    .getByText(/Connecté à Google Drive/)
    .waitFor();
}

async function markSectionRead(page: Page, next = false) {
  await page
    .locator("#catalog")
    .getByRole("button", { name: bookTitle, exact: true })
    .click();
  if (next)
    await page.getByRole("button", { name: "Fragment suivant" }).click();
  await page.getByText("Progression de lecture", { exact: true }).click();
  await page.getByLabel("État de la section").selectOption("read");
  await page.locator("#reader-section-progress").getByText("Terminé").waitFor();
  await page.getByRole("button", { name: "Retour à la bibliothèque" }).click();
}

async function synchronize(page: Page) {
  await page
    .getByLabel("Ouvrage sur cet appareil")
    .selectOption({ label: bookTitle });
  await page
    .getByRole("button", { name: "Synchroniser l’ouvrage choisi" })
    .click();
}

test(
  "Chrome transfers a book and converges after a synthetic Drive token expires",
  { timeout: 60_000 },
  async () => {
    const root = resolve("work/b06-e2e");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "drive-browser-"));
    try {
      const previous = process.env.VITE_DRIVE_CLIENT_ID;
      process.env.VITE_DRIVE_CLIENT_ID =
        "blacture-synthetic.apps.googleusercontent.com";
      try {
        await build({ build: { outDir: directory }, logLevel: "error" });
      } finally {
        if (previous === undefined) delete process.env.VITE_DRIVE_CLIENT_ID;
        else process.env.VITE_DRIVE_CLIENT_ID = previous;
      }
      const headers = await readFile(join(directory, "_headers"), "utf8");
      const policy = /^ {2}Content-Security-Policy: (.+)$/m.exec(headers)?.[1];
      assert.ok(policy);
      const server = await preview({
        build: { outDir: directory },
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
        plugins: [
          {
            name: "qa-public-headers",
            configurePreviewServer(server) {
              server.middlewares.use((_req, res, next) => {
                res.setHeader("Content-Security-Policy", policy.trim());
                res.setHeader(
                  "Cross-Origin-Opener-Policy",
                  "same-origin-allow-popups",
                );
                next();
              });
            },
          },
        ],
      });
      const browser = await chromium.launch({ channel: "chrome" });
      try {
        const address = server.httpServer.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const google = googleFixture(origin);
        const first = await browser.newContext({ serviceWorkers: "block" });
        const second = await browser.newContext({ serviceWorkers: "block" });
        await google.attach(first);
        await google.attach(second);
        const a = await first.newPage();
        const b = await second.newPage();
        a.setDefaultTimeout(10_000);
        b.setDefaultTimeout(10_000);
        await Promise.all([a.goto(origin), b.goto(origin)]);
        await a.getByLabel("Fichier Markdown").setInputFiles({
          name: `${bookTitle}.md`,
          mimeType: "text/markdown",
          buffer: Buffer.from(markdown),
        });
        await a.getByRole("button", { name: "Importer", exact: true }).click();
        await markSectionRead(a);
        await connect(a);
        assert.equal(google.editions(), 0);
        await synchronize(a);
        await a
          .getByText("Ouvrage et progression synchronisés.", { exact: true })
          .waitFor();
        assert.equal(google.editions(), 1);
        await connect(b);
        await b.getByRole("button", { name: "Actualiser la liste" }).click();
        await b
          .getByRole("button", { name: `Télécharger ${bookTitle}` })
          .click();
        await b
          .getByText(
            "Ouvrage disponible hors ligne. Progression Drive récupérée.",
            { exact: true },
          )
          .waitFor();
        await markSectionRead(b, true);
        google.expireNextProgressUpload();
        await synchronize(b);
        await b
          .getByRole("button", { name: "Reprendre la connexion Google Drive" })
          .click();
        await b
          .locator("#drive-status")
          .getByText(/Connecté à Google Drive/)
          .waitFor();
        await synchronize(b);
        await b
          .getByText("Ouvrage et progression synchronisés.", { exact: true })
          .waitFor();
        await synchronize(a);
        await a
          .getByText("Ouvrage et progression synchronisés.", { exact: true })
          .waitFor();
        await a
          .locator("#catalog")
          .getByText("Terminé", { exact: true })
          .waitFor();
        assert.equal(google.editions(), 1);
      } finally {
        await browser.close();
        await server.close();
      }
    } finally {
      const scratch = await realpath(directory);
      assert.equal(dirname(scratch), await realpath(root));
      assert.ok(basename(scratch).startsWith("drive-browser-"));
      await rm(scratch, { recursive: true, maxRetries: 3 });
    }
  },
);
