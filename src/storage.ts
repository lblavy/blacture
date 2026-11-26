import {
  EMPTY_PROGRESS,
  type ProgressState,
  type ReadingIndex,
  type ReadingStatus,
  type ReadingUnit,
} from "./domain/progress";
import type {
  ImportedBook,
  ImportedFragment,
  ImportedResource,
} from "./import";
import { extractReadingUnits } from "./reading-index";

export interface CatalogProgress {
  status: ReadingStatus;
  percent: number;
  hasLast: boolean;
}

export interface CatalogEntry {
  key: string;
  title: string;
  firstFragmentId: string | undefined;
  resourceBytes: number;
  progress?: CatalogProgress;
}

export type Manifest = Omit<ImportedBook, "fragments" | "resources">;
export type FontSize = "small" | "medium" | "large";

const stores = ["catalog", "manifests", "fragments", "resources"];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("blacture-library", 3);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion === 0) {
        for (const store of stores) request.result.createObjectStore(store);
      }
      if (oldVersion < 2) request.result.createObjectStore("preferences");
      request.result.createObjectStore("progress");
      request.result.createObjectStore("reading-indexes");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact<T>(
  names: string[],
  mode: IDBTransactionMode,
  work: (
    transaction: IDBTransaction,
    capture: (value: T) => void,
    fail: (error: unknown) => void,
  ) => void,
  signal?: AbortSignal,
): Promise<T> {
  const database = await openDatabase();
  try {
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(names, mode);
      let value: T;
      const abort = () => {
        try {
          tx.abort();
        } catch (error) {
          if (!(
            error instanceof DOMException && error.name === "InvalidStateError"
          ))
            throw error;
        }
      };
      tx.oncomplete = () => {
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      tx.onabort = () => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? tx.error ?? new Error("Transaction annulée"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      work(
        tx,
        (result) => {
          value = result;
        },
        (error) => {
          reject(error);
          abort();
        },
      );
    });
  } finally {
    database.close();
  }
}

function writeEdition(
  transaction: IDBTransaction,
  key: string,
  book: ImportedBook,
) {
  const { fragments, resources, ...manifest } = book;
  transaction.objectStore("manifests").add(manifest, key);
  const fragmentStore = transaction.objectStore("fragments");
  for (const fragment of fragments)
    fragmentStore.add(fragment, [key, fragment.id]);
  const resourceStore = transaction.objectStore("resources");
  for (const resource of resources)
    resourceStore.add(resource, [key, resource.id]);
}

export async function saveEdition(
  book: ImportedBook,
  signal?: AbortSignal,
): Promise<CatalogEntry> {
  if (book.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new Error("L’édition présente une perte de contenu.");
  }
  const key = JSON.stringify([book.workId, book.editionId]);
  const entry: CatalogEntry = {
    key,
    title: book.title,
    firstFragmentId: book.fragments[0]?.id,
    resourceBytes: book.resources.reduce(
      (total, resource) => total + resource.bytes.byteLength,
      0,
    ),
  };

  return transact(
    stores,
    "readwrite",
    (tx, capture) => {
      const catalog = tx.objectStore("catalog");
      const existing = catalog.get(key);
      existing.onsuccess = () => {
        capture((existing.result as CatalogEntry | undefined) ?? entry);
        if (existing.result) return;
        writeEdition(tx, key, book);
        catalog.add(entry, key);
      };
    },
    signal,
  );
}

function read<T>(
  store: string,
  request: (store: IDBObjectStore) => IDBRequest<T>,
  signal?: AbortSignal,
): Promise<T> {
  return transact(
    [store],
    "readonly",
    (tx, capture) => {
      const result = request(tx.objectStore(store));
      result.onsuccess = () => capture(result.result);
    },
    signal,
  );
}

export function listBooks(): Promise<CatalogEntry[]> {
  return read("catalog", (store) => store.getAll());
}

export function readFragment(
  key: string,
  id: string,
  signal?: AbortSignal,
): Promise<ImportedFragment | undefined> {
  return read("fragments", (store) => store.get([key, id]), signal);
}

export function readManifest(
  key: string,
  signal?: AbortSignal,
): Promise<Manifest | undefined> {
  return read("manifests", (store) => store.get(key), signal);
}

export function readResources(
  key: string,
  ids: string[],
  signal?: AbortSignal,
): Promise<ImportedResource[]> {
  return transact(
    ["resources"],
    "readonly",
    (tx, capture) => {
      const store = tx.objectStore("resources");
      const resources: ImportedResource[] = [];
      capture(resources);
      for (const id of ids) {
        const request = store.get([key, id]);
        request.onsuccess = () => {
          if (request.result)
            resources.push(request.result as ImportedResource);
        };
      }
    },
    signal,
  );
}

export function isFontSize(value: unknown): value is FontSize {
  return value === "small" || value === "medium" || value === "large";
}

export async function readFontSize(): Promise<FontSize> {
  const value: unknown = await read("preferences", (store) =>
    store.get("font-size"),
  );
  return isFontSize(value) ? value : "medium";
}

export function saveFontSize(size: FontSize): Promise<void> {
  return transact(["preferences"], "readwrite", (tx) => {
    tx.objectStore("preferences").put(size, "font-size");
  });
}

function initialProgress(): ProgressState {
  return structuredClone(EMPTY_PROGRESS);
}

export async function readProgress(
  key: string,
  signal?: AbortSignal,
): Promise<ProgressState> {
  const saved = await read<ProgressState | undefined>(
    "progress",
    (store) => store.get(key),
    signal,
  );
  return saved ?? initialProgress();
}

export function updateProgress(
  key: string,
  change: (
    current: ProgressState,
    summary: CatalogProgress | undefined,
  ) => {
    state: ProgressState;
    summary?: CatalogProgress;
  },
): Promise<ProgressState> {
  return transact(["catalog", "progress"], "readwrite", (tx, capture, fail) => {
    const catalog = tx.objectStore("catalog");
    const progress = tx.objectStore("progress");
    const entry = catalog.get(key);
    entry.onsuccess = () => {
      const book: CatalogEntry | undefined = entry.result;
      if (!book) {
        fail(new Error("Ouvrage introuvable."));
        return;
      }
      const current = progress.get(key);
      current.onsuccess = () => {
        try {
          const result = change(
            current.result ?? initialProgress(),
            book.progress,
          );
          progress.put(result.state, key);
          if (result.summary)
            catalog.put({ ...book, progress: result.summary }, key);
          capture(result.state);
        } catch (error) {
          fail(error);
        }
      };
    };
  });
}

function unitsForFragment(
  fragment: ImportedFragment,
  id: string,
  section: string,
) {
  if (
    fragment?.id !== id ||
    fragment.sectionId !== section ||
    typeof fragment.html !== "string" ||
    !Array.isArray(fragment.blockIds) ||
    !fragment.blockIds.length
  ) {
    throw new Error("Fragment incohérent.");
  }
  return extractReadingUnits(fragment.html, fragment.blockIds);
}

function scanReadingUnits(
  key: string,
  expected: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<ReadingIndex["fragments"]> {
  return transact(
    ["fragments"],
    "readonly",
    (tx, capture, fail) => {
      const results = new Map<string, ReadingUnit[]>();
      const ids = new Set<string>();
      // IndexedDB orders strings before arrays; the exclusive upper bound delimits this compound prefix.
      const range = IDBKeyRange.bound([key], [key, []], false, true);
      const request = tx.objectStore("fragments").openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          if (results.size !== expected.size)
            fail(new Error("Fragment introuvable."));
          else capture(Object.fromEntries(results));
          return;
        }
        try {
          const [, id] = cursor.primaryKey as [string, string];
          const section = expected.get(id);
          if (section !== undefined) {
            const units = unitsForFragment(
              cursor.value as ImportedFragment,
              id,
              section,
            );
            for (const unit of units) {
              if (ids.has(unit.id))
                throw new Error("Identifiant de passage en double.");
              ids.add(unit.id);
            }
            results.set(id, units);
          }
          cursor.continue();
        } catch (error) {
          fail(error);
        }
      };
    },
    signal,
  );
}

function cacheReadingIndex(
  key: string,
  index: ReadingIndex,
  signal: AbortSignal,
) {
  return transact<ReadingIndex>(
    ["reading-indexes"],
    "readwrite",
    (tx, capture) => {
      const store = tx.objectStore("reading-indexes");
      const existing = store.get(key);
      existing.onsuccess = () => {
        capture(existing.result ?? index);
        if (!existing.result) store.add(index, key);
      };
    },
    signal,
  );
}

async function buildReadingIndex(
  key: string,
  manifest: Manifest,
  signal: AbortSignal,
) {
  const cached = await read<ReadingIndex | undefined>(
    "reading-indexes",
    (store) => store.get(key),
    signal,
  );
  if (cached) return cached;

  const sections = manifest.sections.map(({ id, parentId, fragmentIds }) => ({
    id,
    parentId,
    fragmentIds: [...fragmentIds],
  }));
  const expected = new Map<string, string>();
  for (const section of sections) {
    for (const fragment of section.fragmentIds) {
      if (expected.has(fragment))
        throw new Error("Fragment déclaré plusieurs fois.");
      expected.set(fragment, section.id);
    }
  }
  const fragments = await scanReadingUnits(key, expected, signal);
  return cacheReadingIndex(key, { sections, fragments }, signal);
}

interface IndexBuild {
  controller: AbortController;
  result: Promise<ReadingIndex>;
  readers: number;
}

const builds = new Map<string, IndexBuild>();

function getIndexBuild(key: string, manifest: Manifest) {
  const existing = builds.get(key);
  if (existing) return existing;

  const controller = new AbortController();
  const build: IndexBuild = {
    controller,
    result: buildReadingIndex(key, manifest, controller.signal),
    readers: 0,
  };
  builds.set(key, build);
  return build;
}

export async function readReadingIndex(
  key: string,
  manifest: Manifest,
  signal?: AbortSignal,
): Promise<ReadingIndex> {
  signal?.throwIfAborted();
  if (JSON.stringify([manifest.workId, manifest.editionId]) !== key) {
    throw new Error("Édition incohérente.");
  }
  const build = getIndexBuild(key, manifest);
  build.readers++;

  let abort: (() => void) | undefined;
  try {
    return await new Promise<ReadingIndex>((resolve, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      void build.result.then(resolve, reject);
    });
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
    if (--build.readers === 0) {
      builds.delete(key);
      build.controller.abort();
    }
  }
}
