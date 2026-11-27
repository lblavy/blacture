import { sha256 } from "../import/identity";
import {
  adoptDriveEdition,
  applyRemoteProgress,
  bindDriveAccount,
  ensureProgressJournal,
  exportEdition,
  indexFromBook,
  listBooks,
  readDriveBinding,
  readDriveProgressCursor,
  readDriveTicket,
  readFragment,
  readManifest,
  readProgressJournal,
  readRestoredProgressJournals,
  readReadingIndex,
  saveEdition,
  writeDriveProgressCursor,
  writeDriveTicket,
} from "../storage";
import {
  createDriveTransport,
  type DriveAuthorization,
  type DriveFile,
} from "./drive-transport";
import {
  editionDigest,
  revisionDigests,
  revisionLinksFromHeader,
  revisionSuffix,
  visibleDriveEditions,
} from "./drive-revisions";
import { uploadDriveObject, type TransferStore } from "./drive-upload";
import {
  assembleEditionPackage,
  encodeEditionPackage,
  type EditionPackage,
} from "./edition-package";
import {
  decodeProgressBatch,
  fingerprintProgressIndex,
  nextProgressBatch,
} from "./progress-batches";
import { validateDriveProgressReferences } from "./progress-references";
import { validateDriveEdition } from "./validate-edition";
import type { ProgressJournal } from "./local-progress";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ConnectedDrive {
  readonly auth: DriveAuthorization;
  readonly accountId: string;
}

type Transport = ReturnType<typeof createDriveTransport>;

function transferStore(accountId: string): TransferStore {
  return {
    read: (key) => readDriveTicket(accountId, key),
    write: (key, ticket) => writeDriveTicket(accountId, key, ticket),
  };
}

function editionFiles(files: readonly DriveFile[], editionHash: string) {
  return files.filter(
    (file) => file.kind === "edition" && file.editionHash === editionHash,
  );
}

function resourceFiles(files: readonly DriveFile[]) {
  return new Map(
    files
      .filter(({ kind }) => kind === "resource")
      .map((file) => [file.digest, file]),
  );
}

export function createDriveLibrary(drive: Transport = createDriveTransport()) {
  const knownRevisionLinks = new Map<
    string,
    { predecessorHash: string; sourceHash: string }
  >();

  async function resolvePredecessor(auth: DriveAuthorization, file: DriveFile) {
    if (
      (file.predecessorHash && file.sourceHash) ||
      !file.title?.endsWith(revisionSuffix)
    )
      return file;
    const fromCache = knownRevisionLinks.get(file.digest);
    if (fromCache) return { ...file, ...fromCache };
    try {
      const header = await drive.readEditionHeader(auth, file);
      const links = header && (await revisionLinksFromHeader(header, file));
      if (links) {
        knownRevisionLinks.set(file.digest, links);
        return { ...file, ...links };
      }
    } catch {
      auth.signal?.throwIfAborted();
    }
    return file;
  }

  async function checkBinding(accountId: string) {
    const bound = await readDriveBinding();
    if (bound && bound !== accountId)
      throw new Error(
        "Ce profil Blacture est associé à un autre compte Google Drive.",
      );
  }

  async function connect(auth: DriveAuthorization): Promise<ConnectedDrive> {
    const accountId = await drive.account(auth);
    await checkBinding(accountId);
    return { auth, accountId };
  }

  async function list(connection: ConnectedDrive) {
    await checkBinding(connection.accountId);
    const local = await listBooks();
    const files = await drive.list(connection.auth);
    await checkBinding(connection.accountId);
    const editions = new Map<string, DriveFile>();
    for (const file of files) {
      if (
        file.kind === "edition" &&
        file.editionHash &&
        !editions.has(file.digest)
      )
        editions.set(file.digest, file);
    }
    const localHashes = new Set(
      await Promise.all(local.map(({ key }) => editionDigest(key))),
    );
    const resolved = [];
    for (const file of editions.values())
      resolved.push(await resolvePredecessor(connection.auth, file));
    return {
      local: local.map(({ key, title }) => ({ key, title })),
      remote: visibleDriveEditions(resolved, localHashes).map(
        ({ id, title }) => ({
          key: id,
          title: title || "Ouvrage Blacture",
        }),
      ),
    };
  }

  async function publishEdition(
    connection: ConnectedDrive,
    key: string,
    scope: string,
    files: DriveFile[],
  ) {
    const { accountId, auth } = connection;
    const book = await exportEdition(key, auth.signal);
    const bytes = encoder.encode(encodeEditionPackage(book));
    const digest = await sha256(bytes);
    const existing = editionFiles(files, scope);
    if (existing.some((file) => file.digest !== digest))
      throw new Error(
        "Cette édition est déjà présente dans Drive avec un autre rendu.",
      );
    const tickets = transferStore(accountId);
    const resources = resourceFiles(files);
    for (const resource of book.resources) {
      if (resources.has(resource.id)) continue;
      await uploadDriveObject(
        auth,
        { kind: "resource", bytes: resource.bytes },
        tickets,
        drive,
      );
    }
    if (!existing.length) {
      const links = await revisionDigests(book);
      const title = links ? `${book.title}${revisionSuffix}` : book.title;
      await uploadDriveObject(
        auth,
        {
          kind: "edition",
          bytes,
          editionHash: scope,
          title,
          ...links,
        },
        tickets,
        drive,
      );
    }
  }

  async function pullProgress(
    connection: ConnectedDrive,
    key: string,
    scope: string,
    files: DriveFile[],
  ) {
    const { auth } = connection;
    const manifest = await readManifest(key, auth.signal);
    if (!manifest) throw new Error("Ouvrage indisponible sur cet appareil.");
    const index = await readReadingIndex(key, manifest, auth.signal);
    const fingerprint = await fingerprintProgressIndex(index);
    const events = await readRemoteProgress(
      auth,
      key,
      scope,
      fingerprint,
      files,
    );
    await validateDriveProgressReferences(events, index, manifest, (id) =>
      readFragment(key, id, auth.signal),
    );
    await ensureProgressJournal(key, auth.signal);
    if (events.length)
      await applyRemoteProgress(key, index, events, auth.signal);
    return fingerprint;
  }

  async function readRemoteProgress(
    auth: DriveAuthorization,
    key: string,
    scope: string,
    fingerprint: string,
    files: readonly DriveFile[],
  ) {
    const unique = new Map<string, DriveFile>();
    for (const file of files) {
      if (file.kind === "progress" && file.editionHash === scope)
        unique.set(file.digest, file);
    }
    const events = [];
    for (const file of unique.values()) {
      const json = decoder.decode(await drive.download(auth, file));
      for (const event of decodeProgressBatch(json, key, fingerprint))
        events.push(event);
    }
    return events;
  }

  async function pushProgress(
    connection: ConnectedDrive,
    key: string,
    scope: string,
    fingerprint: string,
  ) {
    const journal = await readProgressJournal(key, connection.auth.signal);
    if (!journal) return;
    const owner = { key, deviceId: journal.deviceId };
    const journals = await readRestoredProgressJournals(
      key,
      connection.auth.signal,
    );
    for (const { journal, cursorKey } of journals)
      await pushJournal(
        connection,
        key,
        scope,
        fingerprint,
        journal,
        cursorKey,
        owner,
      );
    await pushJournal(connection, key, scope, fingerprint, journal, key, owner);
  }

  async function pushJournal(
    connection: ConnectedDrive,
    key: string,
    scope: string,
    fingerprint: string,
    journal: ProgressJournal,
    cursorKey: string,
    owner: { key: string; deviceId: string },
  ) {
    const { accountId, auth } = connection;
    const tickets = transferStore(accountId);
    let cursor = await readDriveProgressCursor(accountId, cursorKey);
    for (;;) {
      const next = nextProgressBatch(key, fingerprint, journal, cursor);
      if (!next) return;
      if (cursor.pendingThrough === undefined)
        await writeDriveProgressCursor(
          accountId,
          cursorKey,
          {
            sentThrough: cursor.sentThrough,
            pendingThrough: next.through,
          },
          owner,
        );
      await uploadDriveObject(
        auth,
        { kind: "progress", editionHash: scope, bytes: next.bytes },
        tickets,
        drive,
      );
      cursor = { sentThrough: next.through };
      await writeDriveProgressCursor(accountId, cursorKey, cursor, owner);
    }
  }

  async function synchronize(
    connection: ConnectedDrive,
    key: string,
    progressOnly = false,
  ) {
    await bindDriveAccount(connection.accountId);
    const scope = await editionDigest(key);
    const files = await drive.list(connection.auth);
    if (progressOnly && !editionFiles(files, scope).length)
      throw new Error("L’ouvrage associé manque dans Google Drive.");
    if (!progressOnly) await publishEdition(connection, key, scope, files);
    const fingerprint = await pullProgress(connection, key, scope, files);
    await pushProgress(connection, key, scope, fingerprint);
  }

  async function readDriveBook(
    auth: DriveAuthorization,
    pkg: EditionPackage,
    files: readonly DriveFile[],
  ) {
    const resources = resourceFiles(files);
    return assembleEditionPackage(pkg, (descriptor) => {
      const remote = resources.get(descriptor.id);
      if (!remote || remote.size !== descriptor.size)
        throw new Error("Une image de l’ouvrage est absente de Google Drive.");
      return drive.download(auth, remote);
    });
  }

  async function installDriveEdition(
    auth: DriveAuthorization,
    pkg: EditionPackage,
    files: readonly DriveFile[],
    confirmReplacement?: (title: string) => boolean,
  ) {
    const { workId, editionId, replacesEditionId } = pkg.manifest;
    const key = JSON.stringify([workId, editionId]);
    const predecessor =
      replacesEditionId && JSON.stringify([workId, replacesEditionId]);
    const previous = predecessor
      ? await readManifest(predecessor, auth.signal)
      : undefined;
    if (previous && !confirmReplacement?.(previous.title))
      throw new Error("Remplacement annulé. L’édition locale est conservée.");
    const book = await readDriveBook(auth, pkg, files);
    if (!previous || !predecessor) {
      const saved = await saveEdition(book, auth.signal);
      if (saved.key !== key)
        throw new Error(
          "Une autre édition de cet ouvrage est déjà présente dans la bibliothèque.",
        );
      return false;
    }
    const index = indexFromBook(book);
    const scope = await editionDigest(key);
    const fingerprint = await fingerprintProgressIndex(index);
    const events = await readRemoteProgress(
      auth,
      key,
      scope,
      fingerprint,
      files,
    );
    const fragments = new Map(
      book.fragments.map((fragment) => [fragment.id, fragment]),
    );
    await validateDriveProgressReferences(events, index, book, (id) =>
      Promise.resolve(fragments.get(id)),
    );
    await adoptDriveEdition(predecessor, book, index, events, auth.signal);
    return true;
  }

  async function download(
    connection: ConnectedDrive,
    id: string,
    confirmReplacement?: (title: string) => boolean,
  ) {
    const { auth, accountId } = connection;
    await bindDriveAccount(accountId);
    const files = await drive.list(auth);
    const file = files.find(
      (entry) => entry.id === id && entry.kind === "edition",
    );
    if (!file?.editionHash)
      throw new Error("Cet ouvrage est absent de Google Drive.");
    const pkg = await validateDriveEdition(
      await drive.download(auth, file),
      auth.signal,
    );
    const key = JSON.stringify([pkg.manifest.workId, pkg.manifest.editionId]);
    const scope = await editionDigest(key);
    if (scope !== file.editionHash)
      throw new Error(
        "La clé de l’ouvrage ne correspond pas au fichier Google Drive.",
      );
    await verifyRevisionMetadata(file, pkg.manifest);
    const existing = await readManifest(key, auth.signal);
    if (existing) {
      const current = encoder.encode(
        encodeEditionPackage(await exportEdition(key, auth.signal)),
      );
      if ((await sha256(current)) !== file.digest)
        throw new Error(
          "Une copie locale de cette édition possède un autre rendu.",
        );
    } else if (await installDriveEdition(auth, pkg, files, confirmReplacement))
      return key;
    await pullProgress(connection, key, scope, files);
    return key;
  }

  return { connect, list, synchronize, download };
}

async function verifyRevisionMetadata(
  file: DriveFile,
  manifest: EditionPackage["manifest"],
) {
  if (!file.predecessorHash && !file.sourceHash) return;
  const links = await revisionDigests(manifest);
  if (
    (file.predecessorHash && file.predecessorHash !== links?.predecessorHash) ||
    (file.sourceHash && file.sourceHash !== links?.sourceHash)
  )
    throw new Error(
      "Les références de révision déclarées sur Drive sont incohérentes.",
    );
}
