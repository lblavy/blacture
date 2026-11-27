import { sha256 } from "../import/identity";
import type { DriveFile } from "./drive-transport";

export const revisionSuffix = " · édition mise à jour";

const encoder = new TextEncoder();
// The manifest identity comes first in the canonical encoding of a v2 package.
const revisionIdentity =
  /^\{"schemaVersion":2,"manifest":\{"schemaVersion":1,"workId":("(?:[^"\\]|\\.)*"),"editionId":"([a-f0-9]{64})","sourceEditionId":"([a-f0-9]{64})","replacesEditionId":"([a-f0-9]{64})",/u;

export function editionDigest(key: string) {
  return sha256(encoder.encode(key));
}

export async function revisionLinksFromHeader(header: string, file: DriveFile) {
  const identity = revisionIdentity.exec(header);
  if (!identity) return;
  const [, work, edition, source, predecessor] = identity;
  const workId: unknown = JSON.parse(work!);
  if (typeof workId !== "string" || !workId || edition === predecessor) return;
  if (
    (await editionDigest(JSON.stringify([workId, edition]))) !==
    file.editionHash
  )
    return;
  return revisionDigests({
    workId,
    replacesEditionId: predecessor!,
    sourceEditionId: source!,
  });
}

export async function revisionDigests({
  workId,
  replacesEditionId,
  sourceEditionId,
}: {
  workId: string;
  replacesEditionId?: string;
  sourceEditionId?: string;
}) {
  if (!replacesEditionId || !sourceEditionId) return;
  const [predecessorHash, sourceHash] = await Promise.all([
    editionDigest(JSON.stringify([workId, replacesEditionId])),
    editionDigest(JSON.stringify([workId, sourceEditionId])),
  ]);
  return { predecessorHash, sourceHash };
}

function indexEditions(files: readonly DriveFile[]) {
  const byEdition = new Map<string, DriveFile | undefined>();
  for (const file of files) {
    if (file.editionHash)
      byEdition.set(
        file.editionHash,
        byEdition.has(file.editionHash) ? undefined : file,
      );
  }
  return byEdition;
}

function chooseFromLineage(
  head: DriveFile,
  byEdition: ReadonlyMap<string, DriveFile | undefined>,
  localEditions: ReadonlySet<string>,
  covered: Set<string>,
) {
  const seen = new Set<string>();
  let next: DriveFile | undefined;
  for (let file: DriveFile | undefined = head; file && !seen.has(file.id);) {
    seen.add(file.id);
    covered.add(file.id);
    const predecessor = file.predecessorHash;
    if (!predecessor) break;
    if (localEditions.has(predecessor)) next ??= file;
    file = byEdition.get(predecessor);
  }
  return (next ?? head).id;
}

export function visibleDriveEditions(
  files: readonly DriveFile[],
  localEditions: ReadonlySet<string>,
) {
  const byEdition = indexEditions(files);
  const replaced = new Set(files.map(({ predecessorHash }) => predecessorHash));
  const covered = new Set<string>();
  const selected = new Set<string>();
  for (const file of files) {
    if (!file.editionHash || replaced.has(file.editionHash)) continue;
    selected.add(chooseFromLineage(file, byEdition, localEditions, covered));
  }
  const candidates = files.filter(
    ({ id }) => selected.has(id) || !covered.has(id),
  );
  return distinctSources(candidates, localEditions);
}

function preference(file: DriveFile, local: ReadonlySet<string>) {
  if (file.editionHash && local.has(file.editionHash)) return 2;
  return Number(
    Boolean(file.predecessorHash && local.has(file.predecessorHash)),
  );
}

function distinctSources(
  files: readonly DriveFile[],
  local: ReadonlySet<string>,
) {
  const results = new Map<string, DriveFile>();
  for (const file of files) {
    const source = file.sourceHash ?? file.editionHash;
    const key = source ? `source:${source}` : `file:${file.id}`;
    const previous = results.get(key);
    if (!previous || preference(file, local) > preference(previous, local))
      results.set(key, file);
  }
  return [...results.values()];
}
