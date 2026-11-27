import {
  FULL_COVERAGE,
  READING_TIME_MS,
  type ReadingIndex,
  type ReadingMode,
  type ReadingPosition,
  type ReadingSample,
} from "../domain/progress";
import {
  mergeProgressEvents,
  type ProgressEvent,
} from "../domain/progress-sync";
import { sha256 } from "../import/identity";
import { maxProgressClock, type ProgressJournal } from "./local-progress";

const maxBatchLength = 256_000;
const maxEvents = 500;
const maxSamples = 128;
const maxIdentifierLength = 2048;
const maxDeviceIdLength = 128;

function invalidBatch(): never {
  throw new Error("Lot de progression invalide.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalidBatch();
  return value as Record<string, unknown>;
}

function identifier(value: unknown, maxLength = maxIdentifierLength): string {
  if (typeof value !== "string" || !value || value.length > maxLength)
    invalidBatch();
  return value;
}

function boundedItems(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit)
    invalidBatch();
  return value;
}

function positiveNumber(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max
  )
    invalidBatch();
  return value;
}

function positiveInteger(value: unknown, max: number): number {
  const number = positiveNumber(value, max);
  if (!Number.isInteger(number)) invalidBatch();
  return number;
}

function readSample(value: unknown): ReadingSample {
  const sample = record(value);
  return {
    unitId: identifier(sample.unitId),
    elapsedMs: positiveNumber(sample.elapsedMs, READING_TIME_MS),
    coverage: positiveInteger(sample.coverage, FULL_COVERAGE),
  };
}

function readMode(value: unknown): ReadingMode {
  if (value !== "auto" && value !== "read" && value !== "unread")
    invalidBatch();
  return value;
}

function readPosition(value: unknown): ReadingPosition {
  const position = record(value);
  const result: ReadingPosition = {
    fragmentId: identifier(position.fragmentId),
  };
  if (position.blockId !== undefined)
    result.blockId = identifier(position.blockId);
  if (position.anchor !== undefined)
    result.anchor = identifier(position.anchor);
  return result;
}

function readEvent(value: unknown, deviceId: string): ProgressEvent {
  const event = record(value);
  if (event.deviceId !== deviceId) invalidBatch();
  const stamp = {
    deviceId,
    clock: positiveInteger(event.clock, maxProgressClock),
  };
  switch (event.kind) {
    case "observe":
      return {
        ...stamp,
        kind: event.kind,
        samples: boundedItems(event.samples, maxSamples).map(readSample),
      };
    case "mode":
      return {
        ...stamp,
        kind: event.kind,
        scopeId: identifier(event.scopeId),
        mode: readMode(event.mode),
      };
    case "visit":
      return {
        ...stamp,
        kind: event.kind,
        position: readPosition(event.position),
      };
    default:
      return invalidBatch();
  }
}

function parseJson(json: string): unknown {
  if (json.length > maxBatchLength)
    throw new Error("Lot de progression trop volumineux.");
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return invalidBatch();
  }
}

export function decodeProgressBatch(
  json: string,
  editionKey: string,
  indexFingerprint: string,
): ProgressEvent[] {
  const batch = record(parseJson(json));
  if (batch.schemaVersion !== 1) invalidBatch();
  if (identifier(batch.editionKey) !== editionKey)
    throw new Error("Le lot de progression concerne une autre édition.");
  if (batch.indexFingerprint !== indexFingerprint)
    throw new Error(
      "Le lot de progression utilise un index de lecture différent.",
    );
  const deviceId = identifier(batch.deviceId, maxDeviceIdLength);
  return boundedItems(batch.events, maxEvents).map((event) =>
    readEvent(event, deviceId),
  );
}

export interface ProgressCursor {
  sentThrough: number;
  pendingThrough?: number;
}

function batchEvents(
  journal: readonly ProgressEvent[],
  cursor: ProgressCursor,
  initialLength: number,
) {
  const events: ProgressEvent[] = [];
  let length = initialLength;
  for (const event of journal) {
    if (event.clock <= cursor.sentThrough) continue;
    if (
      cursor.pendingThrough !== undefined &&
      event.clock > cursor.pendingThrough
    )
      break;
    length += JSON.stringify(event).length + (events.length ? 1 : 0);
    if (length > maxBatchLength || events.length === maxEvents) break;
    events.push(event);
  }
  return events;
}

export function nextProgressBatch(
  editionKey: string,
  indexFingerprint: string,
  journal: ProgressJournal,
  cursor: ProgressCursor,
) {
  const header = {
    schemaVersion: 1,
    editionKey,
    indexFingerprint,
    deviceId: journal.deviceId,
  };
  const events = batchEvents(
    journal.events,
    cursor,
    JSON.stringify({ ...header, events: [] }).length,
  );
  const through = events.at(-1)?.clock;
  if (cursor.pendingThrough !== undefined && through !== cursor.pendingThrough)
    throw new Error("Le lot de progression en attente est introuvable.");
  if (through === undefined) {
    if ((journal.events.at(-1)?.clock ?? 0) > cursor.sentThrough)
      throw new Error(
        "Un événement de progression dépasse la taille autorisée.",
      );
    return undefined;
  }
  const body = JSON.stringify({ ...header, events });
  return { through, bytes: new TextEncoder().encode(body) };
}

export function fingerprintProgressIndex(index: ReadingIndex): Promise<string> {
  const outline = index.sections.map(({ id, parentId, fragmentIds }) => [
    id,
    parentId,
    fragmentIds.map((fragmentId) => {
      const units = Object.hasOwn(index.fragments, fragmentId)
        ? index.fragments[fragmentId]
        : undefined;
      return [fragmentId, (units ?? []).map(({ id, weight }) => [id, weight])];
    }),
  ]);
  return sha256(new TextEncoder().encode(JSON.stringify(outline)));
}

export async function projectProgressBatches(
  index: ReadingIndex,
  editionKey: string,
  jsonBatches: readonly string[],
) {
  const indexFingerprint = await fingerprintProgressIndex(index);
  return mergeProgressEvents(
    index,
    jsonBatches.flatMap((json) =>
      decodeProgressBatch(json, editionKey, indexFingerprint),
    ),
  );
}
