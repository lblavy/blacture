import { expect, it, vi } from "vitest";
import { createOfflineCache } from "../src/offline-cache";

const scope = "https://example.test/pwa/";
const name = `blacture-pwa:${scope}:`;

function setup(files = ["index.html", "assets/app.js", "verger.png"]) {
  const cache = { addAll: vi.fn(), match: vi.fn() };
  const storage = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi
      .fn()
      .mockResolvedValue([`${name}v1`, `${name}v2`, "outside-cache"]),
    delete: vi.fn(),
  };
  const network = vi.fn();
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
  const { cache, storage, offline } = setup();
  await offline.install();
  expect(storage.open).toHaveBeenCalledWith(`${name}v2`);
  const requests = cache.addAll.mock.calls[0]?.[0] as Request[];
  expect(requests.map((request) => request.url)).toEqual(
    ["", "assets/app.js", "verger.png"].map((file) => scope + file),
  );
  expect(requests.every((request) => request.cache === "reload")).toBe(true);
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
