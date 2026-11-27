import { expect, it, vi } from "vitest";
import { createOfflineCache } from "../src/offline-cache";

const scope = "https://example.test/pwa/";
const name = `blacture-pwa:${scope}:`;

function contentType(url: string) {
  if (url.endsWith(".js")) return "application/javascript; charset=UTF-8";
  if (url.endsWith(".css")) return "text/css";
  if (url.endsWith(".webmanifest")) return "application/manifest+json";
  return url.endsWith(".png") ? "image/png" : "text/html";
}

function setup(
  files = [
    "index.html",
    "assets/app.js",
    "assets/app.css",
    "manifest.webmanifest",
    "verger.png",
  ],
) {
  const cache = { put: vi.fn(), match: vi.fn() };
  const storage = {
    open: vi.fn().mockResolvedValue(cache),
    has: vi.fn().mockResolvedValue(false),
    keys: vi
      .fn()
      .mockResolvedValue([`${name}v1`, `${name}v2`, "outside-cache"]),
    delete: vi.fn(),
  };
  const network = vi.fn().mockImplementation(
    async (request: Request) =>
      new Response("asset", {
        headers: { "content-type": contentType(request.url) },
      }),
  );
  const offline = createOfflineCache(
    scope,
    "v2",
    files,
    storage as unknown as CacheStorage,
    network,
  );
  return { cache, storage, network, offline };
}

it("précache tous les fichiers dans la version propre au périmètre", async () => {
  const { cache, storage, network, offline } = setup();
  await offline.install();
  expect(storage.open).toHaveBeenCalledWith(`${name}v2`);
  const requests = network.mock.calls.map(([request]) => request as Request);
  expect(requests.map((request) => request.url)).toEqual(
    [
      "",
      "assets/app.js",
      "assets/app.css",
      "manifest.webmanifest",
      "verger.png",
    ].map((file) => scope + file),
  );
  expect(requests.every((request) => request.cache === "reload")).toBe(true);
  expect(cache.put).toHaveBeenCalledTimes(5);
});

it.each([
  ["assets/app.js", "text/html", 200],
  ["assets/app.css", "text/html", 200],
  ["manifest.webmanifest", "text/html", 200],
  ["verger.png", "text/html", 200],
  ["", "text/plain", 200],
  ["assets/app.js", "application/javascript", 404],
])(
  "refuse la réponse invalide de %s et garde la version active",
  async (file, type, status) => {
    const { cache, storage, network, offline } = setup();
    network.mockImplementation(async (request: Request) =>
      request.url === scope + file
        ? new Response("incorrect release", {
            status,
            headers: { "content-type": type },
          })
        : new Response("asset", {
            headers: { "content-type": contentType(request.url) },
          }),
    );
    await expect(offline.install()).rejects.toThrow();
    expect(cache.put).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(`${name}v2`);
  },
);

it.each(["application/manifest+json", "application/json"])(
  "précache un manifest servi en %s",
  async (type) => {
    const { cache, network, offline } = setup(["manifest.webmanifest"]);
    network.mockResolvedValue(
      new Response("{}", { headers: { "content-type": type } }),
    );
    await offline.install();
    expect(cache.put).toHaveBeenCalledOnce();
  },
);

it("nettoie uniquement le nouveau cache lorsqu’une écriture échoue", async () => {
  const { cache, storage, offline } = setup();
  cache.put
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("quota"));
  await expect(offline.install()).rejects.toThrow("quota");
  expect(storage.delete).toHaveBeenCalledExactlyOnceWith(`${name}v2`);
});

it("préserve une révision déjà présente si sa réinstallation échoue", async () => {
  const { cache, storage, network, offline } = setup();
  storage.has.mockResolvedValue(true);
  network.mockRejectedValueOnce(new Error("réseau"));
  await expect(offline.install()).rejects.toThrow("réseau");
  expect(cache.put).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
});

it("retire seulement les anciennes versions du même périmètre", async () => {
  const { storage, offline } = setup();
  await offline.clean();
  expect(storage.delete).toHaveBeenCalledExactlyOnceWith(`${name}v1`);
});

it("sert la page de démarrage et l’image locale depuis le cache", async () => {
  const { cache, network, offline } = setup();
  const cached = new Response("local");
  cache.match.mockResolvedValue(cached);
  const navigation = {
    method: "GET",
    url: scope + "?source=launcher#verger",
    mode: "navigate",
  };
  expect(await offline.respond(navigation as Request)).toBe(cached);
  expect(cache.match).toHaveBeenCalledWith(scope);
  expect(await offline.respond(new Request(scope + "verger.png"))).toBe(cached);
  expect(cache.match).toHaveBeenLastCalledWith(scope + "verger.png");
  expect(network).not.toHaveBeenCalled();
});

it("laisse passer les requêtes étrangères et récupère un fichier manquant en ligne", async () => {
  const { network, offline } = setup();
  expect(
    offline.respond(new Request("https://example.test/elsewhere")),
  ).toBeUndefined();
  expect(
    offline.respond(new Request(scope + "verger.png", { method: "POST" })),
  ).toBeUndefined();
  expect(
    offline.respond(new Request(scope + "index.html", { method: "HEAD" })),
  ).toBeUndefined();
  const file = new Request(scope + "assets/app.js");
  const response = new Response("network");
  network.mockResolvedValue(response);
  expect(await offline.respond(file)).toBe(response);
  expect(network).toHaveBeenCalledExactlyOnceWith(file);
});

it("retrouve le banc hors ligne derrière la redirection canonique de l’hébergeur", async () => {
  const { cache, network, offline } = setup([
    "index.html",
    "volume/index.html",
  ]);
  const cached = new Response("banc");
  cache.match.mockResolvedValue(cached);
  const navigation = {
    method: "GET",
    url: scope + "volume/",
    mode: "navigate",
  };
  expect(await offline.respond(navigation as Request)).toBe(cached);
  expect(cache.match).toHaveBeenCalledWith(scope + "volume/");
  expect(network).not.toHaveBeenCalled();
});
