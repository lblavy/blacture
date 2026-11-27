import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("lie les événements au cache et attend la demande d’activation", async () => {
  const put = vi.fn();
  const match = vi.fn().mockResolvedValue(new Response("cached"));
  const claim = vi.fn();
  const skipWaiting = vi.fn();
  const callbacks = new Map<string, (event: unknown) => void>();
  vi.stubGlobal(
    "addEventListener",
    (name: string, callback: (event: unknown) => void) => {
      callbacks.set(name, callback);
    },
  );
  vi.stubGlobal("registration", { scope: "https://example.test/" });
  vi.stubGlobal("caches", {
    open: vi.fn().mockResolvedValue({ put, match }),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response("shell", { headers: { "content-type": "text/html" } }),
      ),
  );
  vi.stubGlobal("clients", { claim });
  vi.stubGlobal("skipWaiting", skipWaiting);
  vi.stubGlobal("__BLACTURE_CACHE_REVISION__", "1");
  vi.stubGlobal("__BLACTURE_PRECACHE__", ["index.html"]);
  await import("../src/service-worker");
  const waitUntil = vi.fn();
  callbacks.get("install")?.({ waitUntil });
  await waitUntil.mock.lastCall?.[0];
  expect(put).toHaveBeenCalledOnce();

  callbacks.get("activate")?.({ waitUntil });
  await waitUntil.mock.lastCall?.[0];
  expect(claim).toHaveBeenCalledOnce();

  callbacks.get("message")?.({ data: "different-message", waitUntil });
  expect(skipWaiting).not.toHaveBeenCalled();
  callbacks.get("message")?.({ data: "apply-update", waitUntil });
  expect(skipWaiting).toHaveBeenCalledOnce();
  const respondWith = vi.fn();
  callbacks.get("fetch")?.({
    request: new Request("https://example.test/another"),
    respondWith,
  });
  expect(respondWith).not.toHaveBeenCalled();
  callbacks.get("fetch")?.({
    request: new Request("https://example.test/index.html"),
    respondWith,
  });
  expect(await respondWith.mock.lastCall?.[0]).toBeInstanceOf(Response);
});
