import { createOfflineCache } from "./offline-cache";

declare const __BLACTURE_PRECACHE__: string[];
declare const __BLACTURE_CACHE_REVISION__: string;

interface LifeEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface WorkerEvents {
  install: LifeEvent;
  activate: LifeEvent;
  message: LifeEvent & { data: unknown };
  fetch: { request: Request; respondWith(response: Promise<Response>): void };
}

interface OfflineWorker {
  registration: { scope: string };
  caches: CacheStorage;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  fetch: typeof fetch;
  addEventListener<K extends keyof WorkerEvents>(
    name: K,
    listener: (event: WorkerEvents[K]) => void,
  ): void;
}

const worker = globalThis as unknown as OfflineWorker;
const offline = createOfflineCache(
  worker.registration.scope,
  __BLACTURE_CACHE_REVISION__,
  __BLACTURE_PRECACHE__,
  worker.caches,
  (request) => worker.fetch(request),
);

worker.addEventListener("install", (event) =>
  event.waitUntil(offline.install()),
);
worker.addEventListener("activate", (event) =>
  event.waitUntil(offline.clean().then(() => worker.clients.claim())),
);
worker.addEventListener("message", (event) => {
  if (event.data === "apply-update") event.waitUntil(worker.skipWaiting());
});
worker.addEventListener("fetch", (event) => {
  const response = offline.respond(event.request);
  if (response) event.respondWith(response);
});
