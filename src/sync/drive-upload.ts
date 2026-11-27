import { sha256 } from "../import/identity";
import {
  DriveHttpError,
  type createDriveTransport,
  type DriveAuthorization,
  type DriveFile,
  type DriveUpload,
} from "./drive-transport";

export interface TransferTicket {
  id: string;
  location?: string;
  finished: boolean;
}

export interface TransferStore {
  read(key: string): Promise<TransferTicket | undefined>;
  write(key: string, ticket: TransferTicket): Promise<void>;
}

export type DriveWriter = Pick<
  ReturnType<typeof createDriveTransport>,
  | "reserveId"
  | "startUpload"
  | "probeUpload"
  | "sendChunk"
  | "metadata"
  | "download"
>;

async function resumeUpload(
  auth: DriveAuthorization,
  transfer: DriveUpload,
  drive: DriveWriter,
) {
  try {
    return await drive.probeUpload(auth, transfer);
  } catch (error) {
    if (
      !(error instanceof DriveHttpError) ||
      ![404, 410].includes(error.status)
    )
      throw error;
    return undefined;
  }
}

async function startOrConfirm(
  auth: DriveAuthorization,
  file: DriveFile,
  drive: DriveWriter,
) {
  try {
    return await drive.startUpload(auth, file);
  } catch (error) {
    if (!(error instanceof DriveHttpError) || error.status !== 409) throw error;
    return confirmExisting(auth, file, drive, error);
  }
}

async function confirmExisting(
  auth: DriveAuthorization,
  file: DriveFile,
  drive: DriveWriter,
  cause?: Error,
): Promise<undefined> {
  const remote = await drive.metadata(auth, file.id);
  if (
    remote.id !== file.id ||
    remote.kind !== file.kind ||
    remote.digest !== file.digest ||
    remote.size !== file.size ||
    remote.editionHash !== file.editionHash
  )
    throw new Error("Le fichier Google Drive existant est incompatible.", {
      cause,
    });
  await drive.download(auth, remote);
  return undefined;
}

async function send(
  auth: DriveAuthorization,
  transfer: DriveUpload,
  bytes: Uint8Array<ArrayBuffer>,
  drive: DriveWriter,
  start: number,
) {
  let offset = start;
  for (;;) {
    auth.signal?.throwIfAborted();
    const status = await drive.sendChunk(auth, transfer, bytes, offset);
    if ("finished" in status) return;
    if (status.nextOffset <= offset || status.nextOffset >= bytes.byteLength)
      throw new Error("La position du transfert Google Drive n’a pas avancé.");
    offset = status.nextOffset;
  }
}

export async function uploadDriveObject(
  auth: DriveAuthorization,
  source: Pick<DriveFile, "kind" | "editionHash" | "title"> & {
    bytes: Uint8Array<ArrayBuffer>;
  },
  tickets: TransferStore,
  drive: DriveWriter,
): Promise<DriveFile> {
  const { bytes, ...metadata } = source;
  auth.signal?.throwIfAborted();
  const digest = await sha256(bytes);
  const key = `${metadata.kind}:${digest}`;
  const previous = await tickets.read(key);
  const id = previous?.id ?? (await drive.reserveId(auth));
  const file: DriveFile = { ...metadata, id, digest, size: bytes.byteLength };
  if (previous?.finished) {
    await confirmExisting(auth, file, drive);
    return file;
  }
  if (!previous) await tickets.write(key, { id, finished: false });

  await transferFile(auth, file, bytes, drive, previous?.location, (location) =>
    tickets.write(key, { id, location, finished: false }),
  );
  await tickets.write(key, { id, finished: true });
  return file;
}

async function transferFile(
  auth: DriveAuthorization,
  file: DriveFile,
  bytes: Uint8Array<ArrayBuffer>,
  drive: DriveWriter,
  location: string | undefined,
  rememberLocation: (location: string) => Promise<void>,
) {
  let transfer = location ? { file, location } : undefined;
  const status = transfer && (await resumeUpload(auth, transfer, drive));
  if (!status) {
    transfer = await startOrConfirm(auth, file, drive);
    if (transfer) {
      await rememberLocation(transfer.location);
      await send(auth, transfer, bytes, drive, 0);
    }
  } else if (transfer && "nextOffset" in status) {
    await send(auth, transfer, bytes, drive, status.nextOffset);
  }
}
