import { sha256 } from "../import/identity";
import {
  applyRemoteProgress,
  bindDriveAccount,
  ensureProgressJournal,
  exportEdition,
  listBooks,
  readDriveBinding,
  readDriveProgressCursor,
  readDriveTicket,
  readManifest,
  readProgressJournal,
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
import { uploadDriveObject, type TransferStore } from "./drive-upload";
import {
  assembleEditionPackage,
  encodeEditionPackage,
} from "./edition-package";
import {
  decodeProgressBatch,
  fingerprintProgressIndex,
  nextProgressBatch,
} from "./progress-batches";
import { validateDriveEdition } from "./validate-edition";

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

async function editionDigest(key: string) {
  return sha256(encoder.encode(key));
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
    return {
      local: local.map(({ key, title }) => ({ key, title })),
      remote: [...editions.values()].map(({ id, title }) => ({
        key: id,
        title: title || "Ouvrage Blacture",
      })),
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
    if (!existing.length)
      await uploadDriveObject(
        auth,
        { kind: "edition", bytes, editionHash: scope, title: book.title },
        tickets,
        drive,
      );
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
    await ensureProgressJournal(key, auth.signal);
    if (events.length)
      await applyRemoteProgress(key, index, events, auth.signal);
    return fingerprint;
  }

  async function pushProgress(
    connection: ConnectedDrive,
    key: string,
    scope: string,
    fingerprint: string,
  ) {
    const { accountId, auth } = connection;
    const journal = await readProgressJournal(key, auth.signal);
    if (!journal) return;
    const tickets = transferStore(accountId);
    let cursor = await readDriveProgressCursor(accountId, key);
    for (;;) {
      const next = nextProgressBatch(key, fingerprint, journal, cursor);
      if (!next) return;
      if (cursor.pendingThrough === undefined)
        await writeDriveProgressCursor(accountId, key, {
          sentThrough: cursor.sentThrough,
          pendingThrough: next.through,
        });
      await uploadDriveObject(
        auth,
        { kind: "progress", editionHash: scope, bytes: next.bytes },
        tickets,
        drive,
      );
      cursor = { sentThrough: next.through };
      await writeDriveProgressCursor(accountId, key, cursor);
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

  async function download(connection: ConnectedDrive, id: string) {
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
    const existing = await readManifest(key, auth.signal);
    if (existing) {
      const current = encoder.encode(
        encodeEditionPackage(await exportEdition(key, auth.signal)),
      );
      if ((await sha256(current)) !== file.digest)
        throw new Error(
          "Une copie locale de cette édition possède un autre rendu.",
        );
    } else {
      const resources = resourceFiles(files);
      const book = await assembleEditionPackage(pkg, async (descriptor) => {
        const remote = resources.get(descriptor.id);
        if (!remote || remote.size !== descriptor.size)
          throw new Error(
            "Une image de l’ouvrage est absente de Google Drive.",
          );
        return drive.download(auth, remote);
      });
      await saveEdition(book, auth.signal);
    }
    await pullProgress(connection, key, scope, files);
    return key;
  }

  return { connect, list, synchronize, download };
}
