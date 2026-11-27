import {
  EMPTY_PROGRESS,
  summarizeProgress,
  type ProgressState,
  type ReadingIndex,
  type ReadingStatus,
  type ReadingUnit,
} from "./domain/progress";
import {
  mergeProgressEvents,
  type ProgressEvent,
} from "./domain/progress-sync";
import type {
  ImportedBook,
  ImportedFragment,
  ImportedResource,
} from "./import";
import { extractReadingUnits } from "./reading-index";
import type { TransferTicket } from "./sync/drive-upload";
import {
  initialProgressChanges,
  maxProgressClock,
  type ProgressChange,
  type ProgressJournal,
} from "./sync/local-progress";

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
const journalHeads = "progress-journal-heads";
const journalEvents = "progress-journal-events";
const remoteEvents = "progress-remote-events";
// Leave ample local counter space even when Drive contains an aberrant clock.
const maxRemoteProgressClock = 2 ** 48;
const driveTickets = "drive-transfer-tickets";
const driveProgress = "drive-progress-cursors";
const driveSelections = "drive-edition-selections";
const selectedEditions = "selected-editions";
const driveBindingPreference = "drive-account-binding";
const journalWriteStores = [
  journalHeads,
  journalEvents,
  "preferences",
  "manifests",
];
const devicePreference = "progress-device-id";

interface JournalHead {
  deviceId: string;
  clock: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("blacture-library", 4);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion === 0) {
        for (const store of stores) request.result.createObjectStore(store);
      }
      if (oldVersion < 2) request.result.createObjectStore("preferences");
      if (oldVersion < 3) {
        request.result.createObjectStore("progress");
        request.result.createObjectStore("reading-indexes");
      }
      request.result.createObjectStore(journalHeads);
      request.result.createObjectStore(journalEvents);
      request.result.createObjectStore(remoteEvents);
      request.result.createObjectStore(driveTickets);
      request.result.createObjectStore(driveProgress);
      request.result.createObjectStore(driveSelections);
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

function editionRange(key: string) {
  // A compound string prefix ends before the first array value.
  return IDBKeyRange.bound([key], [key, []], false, true);
}

function orderEditionFragments(
  manifest: Manifest,
  stored: readonly ImportedFragment[],
): ImportedFragment[] {
  const fragments = new Map(stored.map((fragment) => [fragment.id, fragment]));
  const ordered: ImportedFragment[] = [];
  for (const section of manifest.sections) {
    for (const id of section.fragmentIds) {
      const fragment = fragments.get(id);
      if (fragment?.sectionId !== section.id)
        throw new Error("Édition incohérente.");
      ordered.push(fragment);
      fragments.delete(id);
    }
  }
  if (ordered.length !== stored.length) throw new Error("Édition incohérente.");
  return ordered;
}

function readEditionResources(
  tx: IDBTransaction,
  key: string,
  fragments: readonly ImportedFragment[],
  fail: (error: unknown) => void,
): ImportedResource[] {
  const ids = new Set(fragments.flatMap((fragment) => fragment.resourceIds));
  const resources: ImportedResource[] = [];
  const store = tx.objectStore("resources");
  for (const id of ids) {
    const request = store.get([key, id]);
    request.onsuccess = () => {
      const resource: ImportedResource | undefined = request.result;
      if (resource?.id === id) resources.push(resource);
      else fail(new Error("Ressource de l’édition introuvable."));
    };
  }
  return resources;
}

export function exportEdition(
  key: string,
  signal?: AbortSignal,
): Promise<ImportedBook> {
  return transact(
    stores,
    "readonly",
    (tx, capture, fail) => {
      const catalog = tx.objectStore("catalog").getKey(key);
      const manifestRequest = tx.objectStore("manifests").get(key);
      const fragmentsRequest = tx
        .objectStore("fragments")
        .getAll(editionRange(key));
      fragmentsRequest.onsuccess = () => {
        const manifest: Manifest | undefined = manifestRequest.result;
        if (catalog.result === undefined || !manifest) {
          fail(new Error("Ouvrage introuvable."));
          return;
        }
        try {
          if (JSON.stringify([manifest.workId, manifest.editionId]) !== key)
            throw new Error("Édition incohérente.");
          const fragments = orderEditionFragments(
            manifest,
            fragmentsRequest.result,
          );
          const resources = readEditionResources(tx, key, fragments, fail);
          capture({ ...manifest, fragments, resources });
        } catch (error) {
          fail(error);
        }
      };
    },
    signal,
  );
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

export function readDriveBinding(): Promise<string | undefined> {
  return read("preferences", (store) => store.get(driveBindingPreference));
}

function differentDriveAccount() {
  return new Error(
    "Compte Google Drive différent du compte associé à cette installation.",
  );
}

export async function bindDriveAccount(accountId: string): Promise<void> {
  if (!accountId.trim()) throw new Error("Compte Google Drive invalide.");
  await transact(["preferences"], "readwrite", (tx, _capture, fail) => {
    const preferences = tx.objectStore("preferences");
    const binding = preferences.get(driveBindingPreference);
    binding.onsuccess = () => {
      try {
        if (binding.result === undefined)
          preferences.add(accountId, driveBindingPreference);
        else if (binding.result !== accountId) fail(differentDriveAccount());
      } catch (error) {
        fail(error);
      }
    };
  });
}

function driveValue<T>(
  accountId: string,
  storeName: string,
  key: string,
  update?: (previous: T | undefined) => T,
): Promise<T | undefined> {
  return transact(
    ["preferences", storeName],
    update ? "readwrite" : "readonly",
    (tx, capture, fail) => {
      const binding = tx.objectStore("preferences").get(driveBindingPreference);
      binding.onsuccess = () => {
        if (binding.result !== accountId) {
          fail(differentDriveAccount());
          return;
        }
        const store = tx.objectStore(storeName);
        const storageKey = [accountId, key];
        const request = store.get(storageKey);
        request.onsuccess = () => {
          try {
            const previous: T | undefined = request.result;
            const value = update ? update(previous) : previous;
            if (value !== previous) store.put(value, storageKey);
            capture(value);
          } catch (error) {
            fail(error);
          }
        };
      };
    },
  );
}

export function readDriveTicket(
  accountId: string,
  key: string,
): Promise<TransferTicket | undefined> {
  return driveValue(accountId, driveTickets, key);
}

export async function writeDriveTicket(
  accountId: string,
  key: string,
  ticket: TransferTicket,
): Promise<void> {
  await driveValue<TransferTicket>(accountId, driveTickets, key, (previous) => {
    if (previous && previous.id !== ticket.id)
      throw new Error("Transfert Google Drive déjà réservé.");
    if (previous?.finished) return previous;
    const { id, finished, location } = ticket;
    return { id, finished, ...(!finished && location ? { location } : {}) };
  });
}

export interface DriveProgressCursor {
  sentThrough: number;
  pendingThrough?: number;
}

export async function readDriveProgressCursor(
  accountId: string,
  key: string,
): Promise<DriveProgressCursor> {
  return (
    (await driveValue<DriveProgressCursor>(accountId, driveProgress, key)) ?? {
      sentThrough: 0,
    }
  );
}

function validDriveClock(clock: number) {
  return Number.isSafeInteger(clock) && clock >= 0 && clock <= maxProgressClock;
}

function cursorIsObsolete(
  previous: DriveProgressCursor,
  next: DriveProgressCursor,
) {
  if (previous.pendingThrough === undefined)
    return next.sentThrough !== previous.sentThrough;
  if (next.sentThrough === previous.pendingThrough) return false;
  return (
    next.sentThrough !== previous.sentThrough ||
    next.pendingThrough !== previous.pendingThrough
  );
}

export async function writeDriveProgressCursor(
  accountId: string,
  key: string,
  cursor: DriveProgressCursor,
): Promise<void> {
  const { sentThrough, pendingThrough } = cursor;
  if (
    !validDriveClock(sentThrough) ||
    (pendingThrough !== undefined &&
      (!validDriveClock(pendingThrough) || pendingThrough <= sentThrough))
  )
    throw new Error("Curseur Google Drive invalide.");
  await driveValue<DriveProgressCursor>(
    accountId,
    driveProgress,
    key,
    (previous) => {
      if (cursorIsObsolete(previous ?? { sentThrough: 0 }, cursor))
        throw new Error("Curseur Google Drive obsolète.");
      return {
        sentThrough,
        ...(pendingThrough !== undefined ? { pendingThrough } : {}),
      };
    },
  );
}

export async function readDriveSelections(
  accountId: string,
): Promise<string[]> {
  return (
    (await driveValue<string[]>(
      accountId,
      driveSelections,
      selectedEditions,
    )) ?? []
  );
}

export async function trackDriveEdition(
  accountId: string,
  key: string,
): Promise<void> {
  await driveValue<string[]>(
    accountId,
    driveSelections,
    selectedEditions,
    (previous) =>
      previous?.includes(key) ? previous : [...(previous ?? []), key],
  );
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

function writeProgressEvents(
  tx: IDBTransaction,
  key: string,
  head: JournalHead,
  changes: readonly ProgressChange[],
) {
  if (head.clock + changes.length > maxProgressClock)
    throw new Error("Horloge de progression épuisée.");
  const events = tx.objectStore(journalEvents);
  let { clock } = head;
  for (const change of changes) {
    const event: ProgressEvent = {
      ...change,
      deviceId: head.deviceId,
      clock: ++clock,
    };
    events.add(event, [key, clock]);
  }
  tx.objectStore(journalHeads).put({ deviceId: head.deviceId, clock }, key);
}

function initializeJournal(
  tx: IDBTransaction,
  key: string,
  state: ProgressState,
  changes: readonly ProgressChange[],
  fail: (error: unknown) => void,
) {
  const manifestRequest = tx.objectStore("manifests").get(key);
  manifestRequest.onsuccess = () => {
    const manifest: Manifest | undefined = manifestRequest.result;
    if (!manifest) {
      fail(new Error("Ouvrage introuvable."));
      return;
    }
    const preferences = tx.objectStore("preferences");
    const preference = preferences.get(devicePreference);
    preference.onsuccess = () => {
      try {
        const existing: string | undefined = preference.result;
        const deviceId = existing ?? crypto.randomUUID();
        if (!existing) preferences.add(deviceId, devicePreference);
        writeProgressEvents(tx, key, { deviceId, clock: 0 }, [
          ...initialProgressChanges(state, manifest.sections),
          ...changes,
        ]);
      } catch (error) {
        fail(error);
      }
    };
  };
}

function recordProgressChanges(
  tx: IDBTransaction,
  key: string,
  previous: ProgressState,
  changes: readonly ProgressChange[],
  fail: (error: unknown) => void,
) {
  const headRequest = tx.objectStore(journalHeads).get(key);
  headRequest.onsuccess = () => {
    const head: JournalHead | undefined = headRequest.result;
    try {
      if (!head) initializeJournal(tx, key, previous, changes, fail);
      else if (changes.length > 0) writeProgressEvents(tx, key, head, changes);
    } catch (error) {
      fail(error);
    }
  };
}

export function ensureProgressJournal(
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  return transact(
    ["progress", ...journalWriteStores],
    "readwrite",
    (tx, _capture, fail) => {
      const previous = tx.objectStore("progress").get(key);
      previous.onsuccess = () =>
        recordProgressChanges(
          tx,
          key,
          previous.result ?? initialProgress(),
          [],
          fail,
        );
    },
    signal,
  );
}

export function readProgressJournal(
  key: string,
  signal?: AbortSignal,
): Promise<ProgressJournal | undefined> {
  return transact(
    [journalHeads, journalEvents],
    "readonly",
    (tx, capture) => {
      const head = tx.objectStore(journalHeads).get(key);
      head.onsuccess = () => {
        const journal: JournalHead | undefined = head.result;
        if (!journal) {
          capture(undefined);
          return;
        }
        const entries = readLocalEvents(tx, key);
        entries.onsuccess = () =>
          capture({ deviceId: journal.deviceId, events: entries.result });
      };
    },
    signal,
  );
}

function readLocalEvents(
  tx: IDBTransaction,
  key: string,
): IDBRequest<ProgressEvent[]> {
  const range = IDBKeyRange.bound([key, 1], [key, maxProgressClock]);
  return tx.objectStore(journalEvents).getAll(range);
}

function appendRemoteEvents(
  tx: IDBTransaction,
  key: string,
  head: JournalHead,
  received: readonly ProgressEvent[],
  local: readonly ProgressEvent[],
  knownRemote: readonly ProgressEvent[],
) {
  const localClocks = new Set(local.map(({ clock }) => clock));
  const known = new Set(
    knownRemote.map(({ deviceId, clock }) => JSON.stringify([deviceId, clock])),
  );
  let clock = head.clock;
  const store = tx.objectStore(remoteEvents);
  for (const event of received) {
    if (event.deviceId === head.deviceId) {
      if (!localClocks.has(event.clock))
        throw new Error("Événement local inconnu.");
      continue;
    }
    if (event.clock > maxRemoteProgressClock)
      throw new Error("Horloge de progression distante hors limites.");
    clock = Math.max(clock, event.clock);
    const identity = JSON.stringify([event.deviceId, event.clock]);
    if (known.has(identity)) continue;
    known.add(identity);
    store.add(event, [key, event.deviceId, event.clock]);
  }
  if (clock !== head.clock)
    tx.objectStore(journalHeads).put({ ...head, clock }, key);
}

export function applyRemoteProgress(
  key: string,
  index: ReadingIndex,
  received: readonly ProgressEvent[],
  signal?: AbortSignal,
): Promise<ProgressState> {
  return transact(
    ["catalog", "progress", journalHeads, journalEvents, remoteEvents],
    "readwrite",
    (tx, capture, fail) => {
      const headRequest = tx.objectStore(journalHeads).get(key);
      const localRequest = readLocalEvents(tx, key);
      const remoteRequest = tx
        .objectStore(remoteEvents)
        .getAll(editionRange(key));
      const catalog = tx.objectStore("catalog");
      const entry = catalog.get(key);
      entry.onsuccess = () => {
        // Requests within the transaction finish in submission order.
        const head: JournalHead | undefined = headRequest.result;
        const book: CatalogEntry | undefined = entry.result;
        if (!head || !book) {
          fail(new Error("Journal de progression introuvable."));
          return;
        }
        try {
          const local = localRequest.result;
          const remote: ProgressEvent[] = remoteRequest.result;
          const state = mergeProgressEvents(index, [
            ...local,
            ...remote,
            ...received,
          ]);
          appendRemoteEvents(tx, key, head, received, local, remote);
          signal?.throwIfAborted();
          const { status, percent } = summarizeProgress(index, state).book;
          tx.objectStore("progress").put(state, key);
          catalog.put(
            {
              ...book,
              progress: { status, percent, hasLast: Boolean(state.last) },
            },
            key,
          );
          capture(state);
        } catch (error) {
          fail(signal?.aborted ? signal.reason : error);
        }
      };
    },
    signal,
  );
}

interface ProgressUpdate {
  state: ProgressState;
  summary?: CatalogProgress;
  events?: readonly ProgressChange[];
}

export function updateProgress(
  key: string,
  change: (
    current: ProgressState,
    summary: CatalogProgress | undefined,
  ) => ProgressUpdate,
): Promise<ProgressState> {
  return transact(
    ["catalog", "progress", ...journalWriteStores],
    "readwrite",
    (tx, capture, fail) => {
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
            const previous: ProgressState = current.result ?? initialProgress();
            const result = change(previous, book.progress);
            progress.put(result.state, key);
            if (result.summary)
              catalog.put({ ...book, progress: result.summary }, key);
            if (result.events?.length)
              recordProgressChanges(tx, key, previous, result.events, fail);
            capture(result.state);
          } catch (error) {
            fail(error);
          }
        };
      };
    },
  );
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
      const request = tx.objectStore("fragments").openCursor(editionRange(key));
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
