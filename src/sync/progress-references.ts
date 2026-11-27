import {
  BOOK_SCOPE,
  type ReadingIndex,
  type ReadingPosition,
} from "../domain/progress";
import type { ProgressEvent } from "../domain/progress-sync";
import type { ImportDestination, ImportedFragment } from "../import";
import { validateStoredFragment } from "../import/parse";
import { elements, stringProperty } from "../import/tree";
import type { Manifest } from "../storage";

type Destinations = Readonly<Record<string, ImportDestination>>;

export function countAnonymousReferences(
  html: string,
  destinations: Destinations,
) {
  let count = 0;
  for (const element of elements(validateStoredFragment(html).children)) {
    const target = stringProperty(element, "dataTargetAnchor");
    if (
      element.tagName === "a" &&
      target &&
      Object.hasOwn(destinations, target) &&
      !stringProperty(element, "id")
    )
      count++;
  }
  return count;
}

export function generatedReferenceNumber(anchor: string): number | undefined {
  const match = /^blacture-reference-([1-9]\d*)$/u.exec(anchor);
  return match ? Number(match[1]) : undefined;
}

export function authoredAnchorFragments(destinations: Destinations) {
  return new Map(
    Object.values(destinations).map(({ elementId, fragmentId }) => [
      elementId,
      fragmentId,
    ]),
  );
}

function invalidReference(): never {
  throw new Error("Le lot de progression contient une référence invalide.");
}

function positionReferenceIndex(
  index: ReadingIndex,
  destinations: Destinations,
) {
  const sections = new Set(index.sections.map(({ id }) => id));
  const fragments = new Set(
    index.sections.flatMap(({ fragmentIds }) => fragmentIds),
  );
  const units = new Map<string, string>();
  for (const fragmentId of fragments) {
    if (!Object.hasOwn(index.fragments, fragmentId)) continue;
    for (const { id } of index.fragments[fragmentId] ?? [])
      units.set(id, fragmentId);
  }
  return {
    sections,
    fragments,
    units,
    anchors: authoredAnchorFragments(destinations),
  };
}

interface FragmentChecks {
  blocks: Set<string>;
  generatedReference: number;
}

function requiredGeneratedReference(
  anchor: string | undefined,
  fragmentId: string,
  anchors: ReadonlyMap<string, string>,
) {
  if (anchor === undefined || anchors.get(anchor) === fragmentId) return 0;
  const number = generatedReferenceNumber(anchor);
  if (number === undefined) invalidReference();
  return number;
}

function requirePosition(
  { fragmentId, blockId, anchor }: ReadingPosition,
  { fragments, units, anchors }: ReturnType<typeof positionReferenceIndex>,
  pending: Map<string, FragmentChecks>,
) {
  if (!fragments.has(fragmentId)) invalidReference();
  const generatedReference = requiredGeneratedReference(
    anchor,
    fragmentId,
    anchors,
  );
  const unitFragment = blockId === undefined ? undefined : units.get(blockId);
  if (unitFragment !== undefined && unitFragment !== fragmentId)
    invalidReference();
  const missingBlock = unitFragment === undefined ? blockId : undefined;
  if (missingBlock === undefined && generatedReference === 0) return;

  const checks = pending.get(fragmentId) ?? {
    blocks: new Set<string>(),
    generatedReference: 0,
  };
  if (missingBlock !== undefined) checks.blocks.add(missingBlock);
  checks.generatedReference = Math.max(
    checks.generatedReference,
    generatedReference,
  );
  pending.set(fragmentId, checks);
}

function collectFragmentChecks(
  events: readonly ProgressEvent[],
  references: ReturnType<typeof positionReferenceIndex>,
) {
  const pending = new Map<string, FragmentChecks>();
  for (const event of events) {
    switch (event.kind) {
      case "observe":
      case "migrate":
        for (const sample of event.samples)
          if (!references.units.has(sample.unitId)) invalidReference();
        break;
      case "mode":
        if (
          event.scopeId !== BOOK_SCOPE &&
          !references.sections.has(event.scopeId)
        )
          invalidReference();
        break;
      case "visit":
        requirePosition(event.position, references, pending);
        break;
    }
  }
  return pending;
}

function validateFragmentReferences(
  id: string,
  fragment: ImportedFragment | undefined,
  checks: FragmentChecks,
  destinations: Destinations,
) {
  if (!fragment || fragment.id !== id) invalidReference();
  const blocks = new Set(fragment.blockIds);
  for (const block of checks.blocks) if (!blocks.has(block)) invalidReference();
  if (
    checks.generatedReference > 0 &&
    checks.generatedReference >
      countAnonymousReferences(fragment.html, destinations)
  )
    invalidReference();
}

export async function validateDriveProgressReferences(
  events: readonly ProgressEvent[],
  index: ReadingIndex,
  { destinations }: Pick<Manifest, "destinations">,
  readFragment: (id: string) => Promise<ImportedFragment | undefined>,
): Promise<void> {
  const references = positionReferenceIndex(index, destinations);
  const pending = collectFragmentChecks(events, references);
  for (const [id, checks] of pending)
    validateFragmentReferences(
      id,
      await readFragment(id),
      checks,
      destinations,
    );
}
