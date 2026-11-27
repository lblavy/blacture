import type { ProgressState } from "../domain/progress";
import type { ProgressEvent } from "../domain/progress-sync";
import { sha256 } from "../import/identity";
import type { ImportedBook } from "../import/types";
import type { BookBackupSnapshot } from "../storage";
import {
  encodeEditionPackage,
  validateEditionResource,
} from "../sync/edition-package";
import { validateDriveEdition } from "../sync/validate-edition";
import { decodeArchiveProgress } from "./archive-progress";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const signature = encoder.encode("BLACBK01");
const headerSize = 80;
const editionLengthOffset = 8;
const readingLengthOffset = 12;
const editionHashOffset = 16;
const readingHashOffset = 48;
const sectionLimit = 128 * 1024 * 1024;

interface ReadingSnapshot {
  progress: ProgressState;
  events: readonly ProgressEvent[];
}

function invalidArchive(): never {
  throw new Error("Fichier de sauvegarde Blacture invalide ou incomplet.");
}

function jsonBytes(json: string) {
  const bytes = encoder.encode(json);
  if (bytes.length > sectionLimit)
    throw new Error("Une section de la sauvegarde est trop volumineuse.");
  return bytes;
}

function digestBytes(hex: string) {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function compareResourceIds(
  a: ImportedBook["resources"][number],
  b: ImportedBook["resources"][number],
) {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export async function encodeBookArchive(
  { book, progress, events }: ReadingSnapshot & { book: ImportedBook },
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const edition = jsonBytes(encodeEditionPackage(book));
  const reading = jsonBytes(JSON.stringify({ progress, events }));
  const [editionHash, readingHash] = await Promise.all([
    sha256(edition),
    sha256(reading),
  ]);
  signal?.throwIfAborted();

  const header = new Uint8Array(headerSize);
  header.set(signature);
  const view = new DataView(header.buffer);
  view.setUint32(editionLengthOffset, edition.length);
  view.setUint32(readingLengthOffset, reading.length);
  header.set(digestBytes(editionHash), editionHashOffset);
  header.set(digestBytes(readingHash), readingHashOffset);
  const images = [...book.resources]
    .sort(compareResourceIds)
    .map(({ bytes }) => bytes);
  return new Blob([header, edition, reading, ...images], {
    type: "application/octet-stream",
  });
}

async function readBytes(
  file: Blob,
  start: number,
  end: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  signal?.throwIfAborted();
  return bytes;
}

async function readHeader(file: Blob, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (file.size < headerSize || file.size > headerSize + 3 * sectionLimit)
    invalidArchive();
  const header = await readBytes(file, 0, headerSize, signal);
  if (!signature.every((byte, i) => header[i] === byte)) invalidArchive();
  const view = new DataView(header.buffer);
  const editionLength = view.getUint32(editionLengthOffset);
  const readingLength = view.getUint32(readingLengthOffset);
  if (
    !editionLength ||
    !readingLength ||
    editionLength > sectionLimit ||
    readingLength > sectionLimit ||
    headerSize + editionLength + readingLength > file.size
  )
    invalidArchive();
  return {
    editionEnd: headerSize + editionLength,
    readingEnd: headerSize + editionLength + readingLength,
    editionHash: header.subarray(editionHashOffset, readingHashOffset),
    readingHash: header.subarray(readingHashOffset),
  };
}

async function verifyHash(
  bytes: Uint8Array<ArrayBuffer>,
  expected: Uint8Array,
  signal?: AbortSignal,
) {
  const actual = digestBytes(await sha256(bytes));
  signal?.throwIfAborted();
  if (!actual.every((byte, i) => expected[i] === byte))
    throw new Error(
      "L’empreinte de la sauvegarde ne correspond pas à son contenu.",
    );
}

function parseReading(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    return invalidArchive();
  }
}

function hasReadingProgress({
  progress: { observations, modes, last },
  events,
}: ReadingSnapshot): boolean {
  return [
    last,
    Object.keys(observations).length,
    Object.keys(modes).length,
    events.length,
  ].some(Boolean);
}

async function readArchive(
  file: Blob,
  signal: AbortSignal | undefined,
  captureResource?: (resource: ImportedBook["resources"][number]) => void,
) {
  const header = await readHeader(file, signal);
  const edition = await readBytes(file, headerSize, header.editionEnd, signal);
  await verifyHash(edition, header.editionHash, signal);
  const pkg = await validateDriveEdition(edition, signal);
  const resourceBytes = pkg.resources.reduce(
    (size, entry) => size + entry.size,
    0,
  );
  if (header.readingEnd + resourceBytes !== file.size) invalidArchive();

  const reading = await readBytes(
    file,
    header.editionEnd,
    header.readingEnd,
    signal,
  );
  await verifyHash(reading, header.readingHash, signal);
  const snapshot = decodeArchiveProgress(parseReading(reading), pkg);
  let offset = header.readingEnd;
  for (const resource of pkg.resources) {
    const end = offset + resource.size;
    const bytes = await readBytes(file, offset, end, signal);
    await validateEditionResource(resource, bytes);
    captureResource?.({ id: resource.id, mimeType: resource.mimeType, bytes });
    offset = end;
  }
  signal?.throwIfAborted();
  return { pkg, snapshot };
}

export async function inspectBookArchive(
  file: Blob,
  signal?: AbortSignal,
): Promise<{ title: string; resourceCount: number; hasProgress: boolean }> {
  const { pkg, snapshot } = await readArchive(file, signal);
  return {
    title: pkg.manifest.title,
    resourceCount: pkg.resources.length,
    hasProgress: hasReadingProgress(snapshot),
  };
}

export async function decodeBookArchive(
  file: Blob,
  signal?: AbortSignal,
): Promise<BookBackupSnapshot> {
  const resources: ImportedBook["resources"] = [];
  const { pkg, snapshot } = await readArchive(file, signal, (resource) =>
    resources.push(resource),
  );
  return {
    book: { ...pkg.manifest, fragments: pkg.fragments, resources },
    ...snapshot,
  };
}
