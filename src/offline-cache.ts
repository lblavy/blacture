function canonicalIndex(url: string) {
  // Static hosts may redirect index.html to the directory URL.
  return url.replace(/\/index\.html$/, "/");
}

const javascript = /^(?:application|text)\/(?:x-)?(?:java|ecma)script$/;
const precacheMedia = new Map([
  [".html", /^text\/html$/],
  [".css", /^text\/css$/],
  [".js", javascript],
  [".mjs", javascript],
  [".webmanifest", /^application\/(?:manifest\+)?json$/],
  [".png", /^image\/png$/],
]);

function checkPrecacheResponse(url: string, response: Response) {
  if (response.status !== 200)
    throw new Error(`Ressource de version indisponible : ${url}`);
  const path = new URL(url).pathname;
  const extension = path.endsWith("/")
    ? ".html"
    : path.slice(path.lastIndexOf("."));
  const expected = precacheMedia.get(extension);
  const type = (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]!
    .trim()
    .toLowerCase();
  if (expected && !expected.test(type))
    throw new Error(`Type de contenu invalide pour la ressource : ${url}`);
}

export function createOfflineCache(
  scope: string,
  revision: string,
  files: string[],
  storage: CacheStorage,
  network: typeof fetch,
) {
  const prefix = `blacture-pwa:${scope}:`;
  const name = prefix + revision;
  const shell = new Set(
    files.map((file) => canonicalIndex(new URL(file, scope).href)),
  );

  async function install() {
    const existed = await storage.has(name);
    try {
      // Validate the entire shell before storing any response. A Pages fallback
      // can return a successful HTML response for a missing compiled asset.
      const entries = await Promise.all(
        [...shell].map(async (url) => {
          const request = new Request(url, { cache: "reload" });
          const response = await network(request);
          checkPrecacheResponse(url, response);
          return { request, response };
        }),
      );
      const cache = await storage.open(name);
      for (const { request, response } of entries)
        await cache.put(request, response);
    } catch (error) {
      if (!existed) await storage.delete(name);
      throw error;
    }
  }

  async function clean() {
    const names = await storage.keys();
    const older = names.filter((key) => key.startsWith(prefix) && key !== name);
    await Promise.all(older.map((key) => storage.delete(key)));
  }

  async function cacheFirst(key: string, request: Request) {
    const cache = await storage.open(name);
    return (await cache.match(key)) ?? network(request);
  }

  function respond(request: Request): Promise<Response> | undefined {
    if (request.method !== "GET") return;
    const key =
      request.mode === "navigate"
        ? canonicalIndex(request.url.split(/[?#]/, 1)[0]!)
        : canonicalIndex(request.url);
    if (shell.has(key)) return cacheFirst(key, request);
    return undefined;
  }

  return { install, clean, respond };
}
