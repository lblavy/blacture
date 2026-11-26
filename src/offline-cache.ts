function canonicalIndex(url: string) {
  // Static hosts may redirect index.html to the directory URL.
  return url.replace(/\/index\.html$/, "/");
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
    const cache = await storage.open(name);
    await cache.addAll(
      [...shell].map((url) => new Request(url, { cache: "reload" })),
    );
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
