import {
  BOOK_SCOPE,
  FULL_COVERAGE,
  READING_TIME_MS,
  type ProgressState,
  type ReadingIndex,
  type ReadingMode,
  type ReadingObservation,
  type ReadingPosition,
  type ReadingSection,
  type ReadingUnit,
} from "./progress";

interface IndexedUnit extends ReadingUnit {
  sectionId: string;
  fragmentId: string;
}

interface Scope {
  children: Set<string>;
  units: Set<string>;
  unique: boolean;
}

interface Edition {
  scopes: Map<string, Scope>;
  units: Map<string, IndexedUnit>;
}

function occurrenceBase(id: string) {
  // The assembler appends occurrence numbers to repeated generated IDs.
  return (
    /^((?:section-(?:[a-z\d]{14}(?:-\d+)?|prelude)-block|section)-[a-z\d]{14})(?:-\d+)?$/u.exec(
      id,
    )?.[1] ?? id
  );
}

function duplicates(ids: Iterable<string>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    const base = occurrenceBase(id);
    if (seen.has(base)) repeated.add(base);
    seen.add(base);
  }
  return repeated;
}

function readingUnits(index: ReadingIndex, fragmentId: string) {
  return Object.hasOwn(index.fragments, fragmentId)
    ? (index.fragments[fragmentId] ?? [])
    : [];
}

function addReadingUnits(
  edition: Edition,
  scope: Scope,
  section: ReadingSection,
  index: ReadingIndex,
) {
  for (const fragmentId of section.fragmentIds) {
    for (const unit of readingUnits(index, fragmentId)) {
      scope.units.add(unit.id);
      edition.units.set(unit.id, {
        ...unit,
        fragmentId,
        sectionId: section.id,
      });
    }
  }
}

function indexEdition(index: ReadingIndex) {
  const edition: Edition = { scopes: new Map(), units: new Map() };
  edition.scopes.set(BOOK_SCOPE, {
    unique: true,
    children: new Set(),
    units: new Set(),
  });
  const repeated = duplicates(index.sections.map(({ id }) => id));
  for (const section of index.sections) {
    const parent = edition.scopes.get(section.parentId ?? BOOK_SCOPE);
    const scope: Scope = {
      unique:
        parent?.unique === true && !repeated.has(occurrenceBase(section.id)),
      children: new Set(),
      units: new Set(),
    };
    edition.scopes.set(section.id, scope);
    parent?.children.add(section.id);
    addReadingUnits(edition, scope, section, index);
  }
  return edition;
}

function repeatedUnits(index: ReadingIndex) {
  return duplicates(
    Object.values(index.fragments).flatMap((units) =>
      units.map(({ id }) => id),
    ),
  );
}

function matchUnits(
  previous: Edition,
  next: Edition,
  repeated: ReadonlySet<string>,
) {
  const matches = new Map<string, IndexedUnit>();
  for (const [id, unit] of previous.units) {
    const target = next.units.get(id);
    if (
      target?.weight === unit.weight &&
      target.sectionId === unit.sectionId &&
      previous.scopes.get(unit.sectionId)?.unique &&
      next.scopes.get(target.sectionId)?.unique &&
      !repeated.has(occurrenceBase(id))
    ) {
      matches.set(id, target);
    }
  }
  return matches;
}

function sameMembers(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
  accepted: { has(id: string): boolean },
) {
  return (
    previous.size === next.size &&
    [...previous].every((id) => next.has(id) && accepted.has(id))
  );
}

function intactScopes(
  previous: Edition,
  next: Edition,
  matches: ReadonlyMap<string, IndexedUnit>,
) {
  const intact = new Set<string>();
  for (const [id, before] of [...previous.scopes].reverse()) {
    const after = next.scopes.get(id);
    if (
      before.unique &&
      after?.unique &&
      sameMembers(before.units, after.units, matches) &&
      sameMembers(before.children, after.children, intact)
    ) {
      intact.add(id);
    }
  }
  return intact;
}

function matchPosition(
  last: ReadingPosition | undefined,
  previous: ReadingIndex,
  next: ReadingIndex,
  matches: ReadonlyMap<string, IndexedUnit>,
): ReadingPosition | undefined {
  if (!last || last.anchor) return;
  const priorUnits = readingUnits(previous, last.fragmentId);
  const prior = last.blockId
    ? priorUnits.find(({ id }) => id === last.blockId)
    : priorUnits[0];
  const id = prior?.id;
  const unit = id ? matches.get(id) : undefined;
  if (!unit) return;
  if (!last.blockId && readingUnits(next, unit.fragmentId)[0]?.id === unit.id) {
    return { fragmentId: unit.fragmentId };
  }
  return { fragmentId: unit.fragmentId, blockId: unit.id };
}

function sectionModes(
  index: ReadingIndex,
  explicit: ReadonlyMap<string, ReadingMode>,
) {
  const bookMode = explicit.get(BOOK_SCOPE) ?? "auto";
  const effective = new Map<string, ReadingMode>([[BOOK_SCOPE, bookMode]]);
  for (const { id, parentId } of index.sections) {
    const inherited = effective.get(parentId ?? BOOK_SCOPE) ?? bookMode;
    effective.set(id, explicit.get(id) ?? inherited);
  }
  return effective;
}

function migrateObservations(
  previousModes: ReadonlyMap<string, ReadingMode>,
  nextModes: ReadonlyMap<string, ReadingMode>,
  matches: ReadonlyMap<string, IndexedUnit>,
  source: ProgressState["observations"],
) {
  const observations = new Map<string, ReadingObservation>();
  for (const [id, unit] of matches) {
    const before = previousModes.get(unit.sectionId);
    const after = nextModes.get(unit.sectionId);
    if (before === "unread" && after !== "unread") continue;
    const original = Object.hasOwn(source, id) ? source[id] : undefined;
    if (original) observations.set(id, original);
    if (before === "read" && after === "auto") {
      observations.set(id, {
        elapsedMs: READING_TIME_MS,
        coverage: FULL_COVERAGE,
      });
    }
  }
  return Object.fromEntries(observations);
}

export function migrateEditionProgress(
  previousIndex: ReadingIndex,
  nextIndex: ReadingIndex,
  source: ProgressState,
): { progress: ProgressState; omitted: number } {
  const previous = indexEdition(previousIndex);
  const next = indexEdition(nextIndex);
  const repeated = new Set([
    ...repeatedUnits(previousIndex),
    ...repeatedUnits(nextIndex),
  ]);
  const matches = matchUnits(previous, next, repeated);
  const intact = intactScopes(previous, next, matches);
  const entries = Object.entries(source.modes);
  const retained = new Map(entries.filter(([id]) => intact.has(id)));
  const modes = Object.fromEntries(retained);
  const observations = migrateObservations(
    sectionModes(previousIndex, new Map(entries)),
    sectionModes(nextIndex, retained),
    matches,
    source.observations,
  );
  const last = matchPosition(source.last, previousIndex, nextIndex, matches);
  const omitted =
    entries.length -
    retained.size +
    Object.keys(source.observations).filter(
      (id) => !Object.hasOwn(observations, id),
    ).length +
    Number(source.last !== undefined && last === undefined);
  return {
    progress: { observations, modes, ...(last ? { last } : {}) },
    omitted,
  };
}
