import {
  EMPTY_PROGRESS,
  summarizeProgress,
  type ProgressState,
  type ReadingIndex,
  type ReadingPosition,
  type ReadingStatus,
  type ReadingUnit,
} from "./domain/progress";
import {
  mergeProgressEvents,
  type ProgressEvent,
} from "./domain/progress-sync";
import { migrateEditionProgress } from "./domain/edition-migration";
import type {
  ImportedBook,
  ImportedFragment,
  ImportedResource,
} from "./import";
import { fingerprint, sha256 } from "./import/identity";
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
  sourceEditionId?: string;
  hasPreviousEdition?: boolean;
}

export type Manifest = Omit<ImportedBook, "fragments" | "resources">;
export type FontSize = "small" | "medium" | "large";

const stores = ["catalog", "manifests", "fragments", "resources"];
const journalHeads = "progress-journal-heads";
const journalEvents = "progress-journal-events";
const remoteEvents = "progress-remote-events";
const previousEditions = "previous-editions";
const restoredDevices = "restored-progress-devices";
// Leave ample local counter space even when Drive contains an aberrant clock.
const maxRemoteProgressClock = 2 ** 48;
const driveTickets = "drive-transfer-tickets";
const driveProgress = "drive-progress-cursors";
const driveSelections = "drive-edition-selections";
const selectedEditions = "selected-editions";
const driveBindingPreference = "drive-account-binding";
const editionLocalStores = [
  ...stores,
  "progress",
  "reading-indexes",
  journalHeads,
  journalEvents,
  remoteEvents,
  previousEditions,
  restoredDevices,
];
const editionDriveStores = ["preferences", driveSelections, driveProgress];
const journalWriteStores = [journalHeads, journalEvents, "manifests"];

interface JournalHead {
  deviceId: string;
  clock: number;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("blacture-library", 5);
    request.onupgradeneeded = ({ oldVersion }) => {
      if (oldVersion === 0) {
        for (const store of stores) request.result.createObjectStore(store);
      }
      if (oldVersion < 2) request.result.createObjectStore("preferences");
      if (oldVersion < 3) {
        request.result.createObjectStore("progress");
        request.result.createObjectStore("reading-indexes");
      }
      if (oldVersion < 4) {
        for (const store of [
          journalHeads,
          journalEvents,
          remoteEvents,
          driveTickets,
          driveProgress,
          driveSelections,
        ])
          request.result.createObjectStore(store);
      }
      request.result.createObjectStore(previousEditions);
      request.result.createObjectStore(restoredDevices);
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
  const entry = catalogEntry(book);
  const { key } = entry;

  return transact(
    stores,
    "readwrite",
    (tx, capture) => {
      const catalog = tx.objectStore("catalog");
      const existing = catalog.getAll();
      existing.onsuccess = () => {
        const entries: CatalogEntry[] = existing.result;
        const saved = entries.find((candidate) => matchesBook(candidate, book));
        capture(saved ?? entry);
        if (saved) return;
        writeEdition(tx, key, book);
        catalog.add(entry, key);
      };
    },
    signal,
  );
}

function catalogEntry(book: ImportedBook): CatalogEntry {
  return {
    key: JSON.stringify([book.workId, book.editionId]),
    title: book.title,
    ...(book.sourceEditionId ? { sourceEditionId: book.sourceEditionId } : {}),
    firstFragmentId: book.fragments[0]?.id,
    resourceBytes: book.resources.reduce(
      (total, resource) => total + resource.bytes.byteLength,
      0,
    ),
  };
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

function matchesBook(
  entry: CatalogEntry,
  book: ImportedBook,
  matchWork = false,
) {
  const [workId, editionId] = JSON.parse(entry.key) as [string, string];
  const sameWork = workId === book.workId;
  if (!entry.sourceEditionId && !book.sourceEditionId)
    return sameWork && (matchWork || editionId === book.editionId);
  return (
    sameWork ||
    (entry.sourceEditionId ?? editionId) ===
      (book.sourceEditionId ?? book.editionId)
  );
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
  capture: (resources: ImportedResource[]) => void,
  fail: (error: unknown) => void,
) {
  const ids = new Set(fragments.flatMap((fragment) => fragment.resourceIds));
  const resources: ImportedResource[] = [];
  const store = tx.objectStore("resources");
  for (const id of ids) {
    const request = store.get([key, id]);
    request.onsuccess = () => {
      const resource: ImportedResource | undefined = request.result;
      if (resource?.id !== id) {
        fail(new Error("Ressource de l’édition introuvable."));
        return;
      }
      resources.push(resource);
      if (resources.length === ids.size) capture(resources);
    };
  }
  if (ids.size === 0) capture(resources);
}

function readEditionSnapshot(
  tx: IDBTransaction,
  key: string,
  capture: (value: ImportedBook) => void,
  fail: (error: unknown) => void,
) {
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
      readEditionResources(
        tx,
        key,
        fragments,
        (resources) => capture({ ...manifest, fragments, resources }),
        fail,
      );
    } catch (error) {
      fail(error);
    }
  };
}

export function exportEdition(
  key: string,
  signal?: AbortSignal,
): Promise<ImportedBook> {
  return transact(
    stores,
    "readonly",
    (tx, capture, fail) => readEditionSnapshot(tx, key, capture, fail),
    signal,
  );
}

export interface BookBackupSnapshot {
  book: ImportedBook;
  progress: ProgressState;
  events: ProgressEvent[];
}

export class BackupAlreadyPresentError extends Error {
  override name = "BackupAlreadyPresentError";

  constructor() {
    super("Cet ouvrage figure déjà dans la bibliothèque.");
  }
}

export function exportBookBackup(
  key: string,
  signal?: AbortSignal,
): Promise<BookBackupSnapshot> {
  return transact(
    [...stores, "progress", journalEvents, remoteEvents],
    "readonly",
    (tx, capture, fail) => readBackupSnapshot(tx, key, capture, fail),
    signal,
  );
}

function readBackupSnapshot(
  tx: IDBTransaction,
  key: string,
  capture: (snapshot: BookBackupSnapshot) => void,
  fail: (error: unknown) => void,
) {
  const progress = tx.objectStore("progress").get(key);
  const local = readLocalEvents(tx, key);
  const remote = readRemoteEvents(tx, key);
  readEditionSnapshot(
    tx,
    key,
    (book) => {
      capture({
        book,
        progress: progress.result ?? initialProgress(),
        events: [...local.result, ...remote.result],
      });
    },
    fail,
  );
}

export function exportPreviousEdition(
  key: string,
  signal?: AbortSignal,
): Promise<BookBackupSnapshot | undefined> {
  return read(previousEditions, (store) => store.get(key), signal);
}

function removeEdition(transaction: IDBTransaction, key: string) {
  clearEditionDriveState(transaction, key);
  for (const store of [
    "catalog",
    "manifests",
    "progress",
    "reading-indexes",
    journalHeads,
    previousEditions,
    restoredDevices,
  ])
    transaction.objectStore(store).delete(key);
  for (const store of ["fragments", "resources", journalEvents, remoteEvents])
    transaction.objectStore(store).delete(editionRange(key));
}

function restoredCursorKey(key: string, deviceId: string) {
  return JSON.stringify(["restored", key, deviceId]);
}

function clearEditionDriveState(tx: IDBTransaction, key: string) {
  const account = tx.objectStore("preferences").get(driveBindingPreference);
  const devices = tx.objectStore(restoredDevices).get(key);
  devices.onsuccess = () => {
    if (!account.result) return;
    const cursors = tx.objectStore(driveProgress);
    cursors.delete([account.result, key]);
    const restored: Map<string, number[]> | undefined = devices.result;
    for (const deviceId of restored?.keys() ?? [])
      cursors.delete([account.result, restoredCursorKey(key, deviceId)]);
    const store = tx.objectStore(driveSelections);
    const selectionKey = [account.result, selectedEditions];
    const selection = store.get(selectionKey);
    selection.onsuccess = () => {
      const selected: string[] | undefined = selection.result;
      if (selected?.includes(key))
        store.put(
          selected.filter((value) => value !== key),
          selectionKey,
        );
    };
  };
}

export function removeLocalEdition(
  key: string,
  signal?: AbortSignal,
): Promise<void> {
  return transact(
    [...editionLocalStores, ...editionDriveStores],
    "readwrite",
    (tx) => removeEdition(tx, key),
    signal,
  );
}

function editionRender(book: ImportedBook) {
  const fragments = book.fragments.map(
    ({ id, html, blockIds, resourceIds }) => [
      id,
      fingerprint(html),
      blockIds,
      resourceIds,
    ],
  );
  const compare = (left: string, right: string) =>
    left === right ? 0 : left < right ? -1 : 1;
  const destinations = Object.entries(book.destinations).sort(
    ([left], [right]) => compare(left, right),
  );
  const diagnostics = [...book.diagnostics].sort((left, right) =>
    compare(left.code, right.code),
  );
  return JSON.stringify([
    book.sourceEditionId ?? book.editionId,
    book.sections,
    Object.fromEntries(destinations),
    diagnostics,
    fragments,
  ]);
}

export async function replaceEdition(
  key: string,
  incoming: ImportedBook,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (incoming.diagnostics.some(({ severity }) => severity === "error"))
    throw new Error("L’édition présente une perte de contenu.");
  const previous = await readManifest(key, signal);
  if (!previous) throw new Error("Ouvrage introuvable.");
  const { workId, editionId: replacedId, title } = previous;
  const render = editionRender(incoming);
  const editionId = await sha256(
    new TextEncoder().encode(JSON.stringify([replacedId, render])),
  );
  const book: ImportedBook = {
    ...incoming,
    workId,
    title,
    editionId,
    sourceEditionId: incoming.editionId,
    replacesEditionId: replacedId,
  };
  return publishReplacement(key, book, indexFromBook(book), [], signal, render);
}

export function adoptDriveEdition(
  previousKey: string,
  book: ImportedBook,
  index: ReadingIndex,
  received: readonly ProgressEvent[],
  signal?: AbortSignal,
) {
  const [workId, editionId] = JSON.parse(previousKey) as [string, string];
  if (
    workId !== book.workId ||
    editionId !== book.replacesEditionId ||
    editionId === book.editionId
  )
    throw new Error("Cette édition ne remplace pas la copie locale.");
  return publishReplacement(previousKey, book, index, received, signal);
}

function publishReplacement(
  key: string,
  book: ImportedBook,
  nextIndex: ReadingIndex,
  received: readonly ProgressEvent[],
  signal?: AbortSignal,
  render?: string,
) {
  return transact<{ key: string; omitted: number; replaced: boolean }>(
    [...editionLocalStores, ...editionDriveStores],
    "readwrite",
    (tx, capture, fail) => {
      const indexes = tx.objectStore("reading-indexes");
      const archivedIndex = indexes.get(key);
      const catalog = tx.objectStore("catalog");
      const otherBooks = catalog.getAll();
      readBackupSnapshot(
        tx,
        key,
        (previous) => {
          try {
            const entry = catalogEntry(book);
            if (
              render !== undefined &&
              editionRender(previous.book) === render
            ) {
              capture({ key, omitted: 0, replaced: false });
              return;
            }
            if (
              (otherBooks.result as CatalogEntry[]).some(
                (other) => other.key !== key && matchesBook(other, book),
              )
            )
              throw new Error(
                "Ce Markdown correspond déjà à un autre ouvrage de la bibliothèque.",
              );
            const previousIndex: ReadingIndex =
              archivedIndex.result ?? indexFromBook(previous.book);
            const { progress, omitted } = migrateEditionProgress(
              previousIndex,
              nextIndex,
              previous.progress,
            );
            tx.objectStore(previousEditions).add(previous, entry.key);
            removeEdition(tx, key);
            writeEdition(tx, entry.key, book);
            indexes.add(nextIndex, entry.key);
            const merged = importReplacementProgress(
              tx,
              entry.key,
              book,
              nextIndex,
              progress,
              received,
            );
            tx.objectStore("progress").add(merged, entry.key);
            catalog.add(
              {
                ...entry,
                hasPreviousEdition: true,
                progress: readingCatalogProgress(nextIndex, merged),
              },
              entry.key,
            );
            capture({ key: entry.key, omitted, replaced: true });
          } catch (error) {
            fail(signal?.aborted ? signal.reason : error);
          }
        },
        fail,
      );
    },
    signal,
  );
}

function importReplacementProgress(
  tx: IDBTransaction,
  key: string,
  book: ImportedBook,
  index: ReadingIndex,
  migrated: ProgressState,
  received: readonly ProgressEvent[],
) {
  const changes = initialProgressChanges(migrated, book.sections, true);
  const head = { deviceId: crypto.randomUUID(), clock: 0 };
  const written = writeProgressEvents(tx, key, head, changes);
  if (received.length === 0) return migrated;
  const progress = mergeProgressEvents(index, [...written, ...received]);
  appendRemoteEvents(
    tx,
    key,
    { ...head, clock: written.length },
    received,
    written,
    [],
  );
  return progress;
}

function readingCatalogProgress(index: ReadingIndex, state: ProgressState) {
  const { status, percent } = summarizeProgress(index, state).book;
  return { status, percent, hasLast: Boolean(state.last) };
}

function matchingRecords<T>(
  left: Record<string, T>,
  right: Record<string, T>,
  matches: (sample: T, other: T) => boolean,
) {
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && matches(value, right[key]!),
    )
  );
}

function positionFields(position?: ReadingPosition) {
  return JSON.stringify([
    position?.fragmentId,
    position?.blockId,
    position?.anchor,
  ]);
}

function verifyReadingProjection(
  index: ReadingIndex,
  { events, progress }: BookBackupSnapshot,
) {
  if (events.length === 0) return;
  const projected = mergeProgressEvents(index, events);
  if (
    positionFields(projected.last) !== positionFields(progress.last) ||
    !matchingRecords(
      projected.modes,
      progress.modes,
      (left, right) => left === right,
    ) ||
    !matchingRecords(
      projected.observations,
      progress.observations,
      (left, right) =>
        left.coverage === right.coverage &&
        Math.abs(left.elapsedMs - right.elapsedMs) < 1e-7,
    )
  )
    throw new Error(
      "Le journal de la sauvegarde ne correspond pas à sa progression.",
    );
}

export async function restoreBookBackup(
  snapshot: BookBackupSnapshot,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { book, events, progress } = snapshot;
  const entry = catalogEntry(book);
  const { key } = entry;
  const index = indexFromBook(book);
  verifyReadingProjection(index, snapshot);
  return transact(
    [
      ...stores,
      "progress",
      "reading-indexes",
      journalHeads,
      remoteEvents,
      restoredDevices,
      ...editionDriveStores,
    ],
    "readwrite",
    (tx, _capture, fail) => {
      const catalog = tx.objectStore("catalog");
      const existing = catalog.getAll();
      existing.onsuccess = () => {
        try {
          if (
            (existing.result as CatalogEntry[]).some((candidate) =>
              matchesBook(candidate, book, true),
            )
          )
            throw new BackupAlreadyPresentError();
          clearEditionDriveState(tx, key);
          writeEdition(tx, key, book);
          tx.objectStore("reading-indexes").put(index, key);
          tx.objectStore("progress").add(progress, key);
          if (events.length) {
            const store = tx.objectStore(remoteEvents);
            const devices = new Map<string, number[]>();
            let clock = 0;
            for (const event of events) {
              if (event.clock > maxRemoteProgressClock)
                throw new Error(
                  "Horloge de progression sauvegardée hors limites.",
                );
              store.add(event, [key, event.deviceId, event.clock]);
              const clocks = devices.get(event.deviceId) ?? [];
              clocks.push(event.clock);
              devices.set(event.deviceId, clocks);
              clock = Math.max(clock, event.clock);
            }
            tx.objectStore(restoredDevices).add(devices, key);
            tx.objectStore(journalHeads).add(
              { deviceId: crypto.randomUUID(), clock },
              key,
            );
          }
          catalog.add(
            { ...entry, progress: readingCatalogProgress(index, progress) },
            key,
          );
        } catch (error) {
          fail(signal?.aborted ? signal.reason : error);
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

interface JournalOwner {
  key: string;
  deviceId: string;
}

function driveValue<T>(
  accountId: string,
  storeName: string,
  key: string,
  update?: (previous: T | undefined) => T,
  owner?: JournalOwner,
): Promise<T | undefined> {
  const stores = ["preferences", storeName];
  if (owner) stores.push(journalHeads);
  return transact(
    stores,
    update ? "readwrite" : "readonly",
    (tx, capture, fail) => {
      const journal = owner && tx.objectStore(journalHeads).get(owner.key);
      const binding = tx.objectStore("preferences").get(driveBindingPreference);
      binding.onsuccess = () => {
        if (binding.result !== accountId) {
          fail(differentDriveAccount());
          return;
        }
        if (
          owner &&
          (journal?.result as JournalHead | undefined)?.deviceId !==
            owner.deviceId
        ) {
          fail(
            new Error(
              "Le journal de lecture a été remplacé depuis le début de l’envoi.",
            ),
          );
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
  owner?: JournalOwner,
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
    owner,
  );
}

export async function readDriveSelections(
  accountId: string,
): Promise<string[]> {
  const [selected, local] = await Promise.all([
    driveValue<string[]>(accountId, driveSelections, selectedEditions),
    listBooks(),
  ]);
  const available = new Set(local.map(({ key }) => key));
  return (selected ?? []).filter((key) => available.has(key));
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
  const written: ProgressEvent[] = [];
  let { clock } = head;
  for (const change of changes) {
    const event: ProgressEvent = {
      ...change,
      deviceId: head.deviceId,
      clock: ++clock,
    };
    events.add(event, [key, clock]);
    written.push(event);
  }
  tx.objectStore(journalHeads).put({ deviceId: head.deviceId, clock }, key);
  return written;
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
    try {
      writeProgressEvents(
        tx,
        key,
        { deviceId: crypto.randomUUID(), clock: 0 },
        [
          ...initialProgressChanges(
            state,
            manifest.sections,
            Boolean(manifest.sourceEditionId),
          ),
          ...changes,
        ],
      );
    } catch (error) {
      fail(error);
    }
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

export function readRestoredProgressJournals(
  key: string,
  signal?: AbortSignal,
): Promise<{ journal: ProgressJournal; cursorKey: string }[]> {
  return transact(
    [restoredDevices, remoteEvents],
    "readonly",
    (tx, capture) => {
      const devices = tx.objectStore(restoredDevices).get(key);
      const journals: { journal: ProgressJournal; cursorKey: string }[] = [];
      capture(journals);
      devices.onsuccess = () => {
        const store = tx.objectStore(remoteEvents);
        const restored: Map<string, number[]> | undefined = devices.result;
        for (const [deviceId, clocks] of restored ?? []) {
          const pending = new Set(clocks);
          const entries = store.getAll(
            IDBKeyRange.bound(
              [key, deviceId, 1],
              [key, deviceId + "\u0000"],
              false,
              true,
            ),
          );
          entries.onsuccess = () =>
            journals.push({
              journal: {
                deviceId,
                events: (entries.result as ProgressEvent[]).filter(
                  ({ clock }) => pending.has(clock),
                ),
              },
              cursorKey: restoredCursorKey(key, deviceId),
            });
        }
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

function readRemoteEvents(
  tx: IDBTransaction,
  key: string,
): IDBRequest<ProgressEvent[]> {
  return tx.objectStore(remoteEvents).getAll(editionRange(key));
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
      const remoteRequest = readRemoteEvents(tx, key);
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

function editionSections(manifest: Manifest): ReadingIndex["sections"] {
  return manifest.sections.map(({ id, parentId, fragmentIds }) => ({
    id,
    parentId,
    fragmentIds: [...fragmentIds],
  }));
}

export function indexFromBook(book: ImportedBook): ReadingIndex {
  const fragments = new Map<string, ReadingUnit[]>();
  for (const fragment of book.fragments)
    fragments.set(
      fragment.id,
      unitsForFragment(fragment, fragment.id, fragment.sectionId),
    );
  return {
    sections: editionSections(book),
    fragments: Object.fromEntries(fragments),
  };
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
    ["reading-indexes", "manifests"],
    "readwrite",
    (tx, capture, fail) => {
      const store = tx.objectStore("reading-indexes");
      const manifest = tx.objectStore("manifests").getKey(key);
      const existing = store.get(key);
      existing.onsuccess = () => {
        if (manifest.result === undefined) {
          fail(new Error("Ouvrage introuvable."));
          return;
        }
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

  const sections = editionSections(manifest);
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
