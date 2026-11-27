import {
  BOOK_SCOPE,
  type ProgressState,
  type ReadingPosition,
} from "../domain/progress";
import type { ProgressEvent } from "../domain/progress-sync";
import type { EditionPackage } from "../sync/edition-package";
import {
  readProgressEvent,
  readProgressMode,
  readProgressObservation,
  readProgressPosition,
} from "../sync/progress-batches";
import {
  authoredAnchorFragments,
  countAnonymousReferences,
  generatedReferenceNumber,
} from "../sync/progress-references";

function invalidProgress(): never {
  throw new Error("Progression de la sauvegarde invalide.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalidProgress();
  return value as Record<string, unknown>;
}

function editionReferences({ manifest, fragments }: EditionPackage) {
  const sections = new Set(manifest.sections.map(({ id }) => id));
  const byFragment = new Map(
    fragments.map((fragment) => [fragment.id, fragment]),
  );
  const blocks = new Map<string, string>();
  for (const fragment of fragments)
    for (const block of fragment.blockIds) blocks.set(block, fragment.id);
  const anchors = authoredAnchorFragments(manifest.destinations);
  const generatedCounts = new Map<string, number>();

  function hasAnchor(anchor: string, fragment: (typeof fragments)[number]) {
    if (anchors.get(anchor) === fragment.id) return true;
    const number = generatedReferenceNumber(anchor);
    if (number === undefined) return false;
    let count = generatedCounts.get(fragment.id);
    if (count === undefined) {
      count = countAnonymousReferences(fragment.html, manifest.destinations);
      generatedCounts.set(fragment.id, count);
    }
    return number <= count;
  }

  return {
    requireBlock(id: string) {
      if (!blocks.has(id)) invalidProgress();
    },
    requireScope(id: string) {
      if (id !== BOOK_SCOPE && !sections.has(id)) invalidProgress();
    },
    requirePosition({ fragmentId, blockId, anchor }: ReadingPosition) {
      const fragment = byFragment.get(fragmentId);
      if (!fragment) invalidProgress();
      if (blockId && blocks.get(blockId) !== fragmentId) invalidProgress();
      if (anchor && !hasAnchor(anchor, fragment)) invalidProgress();
    },
  };
}

type References = ReturnType<typeof editionReferences>;

function readState(value: unknown, references: References): ProgressState {
  const { observations, modes, last } = record(value);
  const state: ProgressState = {
    observations: Object.fromEntries(
      Object.entries(record(observations)).map(([id, observation]) => {
        references.requireBlock(id);
        return [id, readProgressObservation(observation)];
      }),
    ),
    modes: Object.fromEntries(
      Object.entries(record(modes)).map(([id, mode]) => {
        references.requireScope(id);
        return [id, readProgressMode(mode)];
      }),
    ),
  };
  if (last !== undefined) {
    state.last = readProgressPosition(last);
    references.requirePosition(state.last);
  }
  return state;
}

function validateEventReferences(event: ProgressEvent, references: References) {
  switch (event.kind) {
    case "observe":
    case "migrate":
      for (const sample of event.samples)
        references.requireBlock(sample.unitId);
      break;
    case "mode":
      references.requireScope(event.scopeId);
      break;
    case "visit":
      references.requirePosition(event.position);
      break;
  }
}

export function decodeArchiveProgress(value: unknown, edition: EditionPackage) {
  const data = record(value);
  const references = editionReferences(edition);
  const progress = readState(data.progress, references);
  if (!Array.isArray(data.events)) invalidProgress();
  const identities = new Set<string>();
  const events = (data.events as unknown[]).map((entry) => {
    const event = readProgressEvent(entry);
    const identity = JSON.stringify([event.deviceId, event.clock]);
    if (identities.has(identity)) invalidProgress();
    identities.add(identity);
    validateEventReferences(event, references);
    return event;
  });
  return { progress, events };
}
