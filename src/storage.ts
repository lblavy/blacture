import type {
  ImportedBook,
  ImportedFragment,
  ImportedResource,
} from "./import";

export interface CatalogEntry {
  key: string;
  title: string;
  firstFragmentId: string | undefined;
  resourceBytes: number;
}

type Manifest = Omit<ImportedBook, "fragments" | "resources">;

const stores = ["catalog", "manifests", "fragments", "resources"];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("blacture-library", 1);
    request.onupgradeneeded = () => {
      for (const store of stores) request.result.createObjectStore(store);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function transact<T>(
  names: string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction, capture: (value: T) => void) => void,
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
      work(tx, (result) => {
        value = result;
      });
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
): Promise<T> {
  return transact([store], "readonly", (tx, capture) => {
    const result = request(tx.objectStore(store));
    result.onsuccess = () => capture(result.result);
  });
}

export function listBooks(): Promise<CatalogEntry[]> {
  return read("catalog", (store) => store.getAll());
}

export function readFragment(
  key: string,
  id: string,
): Promise<ImportedFragment | undefined> {
  return read("fragments", (store) => store.get([key, id]));
}

export function readManifest(key: string): Promise<Manifest | undefined> {
  return read("manifests", (store) => store.get(key));
}

export function readResources(
  key: string,
  ids: string[],
): Promise<ImportedResource[]> {
  return transact(["resources"], "readonly", (tx, capture) => {
    const store = tx.objectStore("resources");
    const resources: ImportedResource[] = [];
    capture(resources);
    for (const id of ids) {
      const request = store.get([key, id]);
      request.onsuccess = () => {
        if (request.result) resources.push(request.result as ImportedResource);
      };
    }
  });
}
