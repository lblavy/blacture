import {
  BOOK_SCOPE,
  EMPTY_PROGRESS,
  FULL_COVERAGE,
  changeMode,
  observeReadings,
  setLastConsultation,
  type ProgressState,
  type ReadingIndex,
  type ReadingMode,
  type ReadingPosition,
  type ReadingSample,
} from "./progress";

interface EventIdentity {
  readonly deviceId: string;
  readonly clock: number;
}

export type ProgressEvent = EventIdentity &
  (
    | { readonly kind: "observe"; readonly samples: readonly ReadingSample[] }
    | { readonly kind: "migrate"; readonly samples: readonly ReadingSample[] }
    | {
        readonly kind: "mode";
        readonly scopeId: string;
        readonly mode: ReadingMode;
        readonly inherited?: true;
      }
    | {
        readonly kind: "visit";
        readonly position: ReadingPosition;
        readonly inherited?: true;
      }
  );

export function isInheritedProgressEvent(event: ProgressEvent): boolean {
  return (
    (event.kind === "mode" || event.kind === "visit") &&
    event.inherited === true
  );
}

function mergeMigratedSample(
  samples: Map<string, ReadingSample>,
  sample: ReadingSample,
) {
  const { unitId, elapsedMs, coverage } = sample;
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0 ||
    !Number.isSafeInteger(coverage) ||
    coverage < 1 ||
    coverage > FULL_COVERAGE
  )
    return;
  const previous = samples.get(unitId);
  samples.set(
    unitId,
    previous
      ? {
          unitId,
          elapsedMs: Math.max(previous.elapsedMs, elapsedMs),
          coverage: previous.coverage | coverage,
        }
      : sample,
  );
}

function inheritedState(
  index: ReadingIndex,
  journal: readonly ProgressEvent[],
): ProgressState {
  const candidates = new Map<string, ReadingMode>();
  for (const event of journal) {
    if (event.kind === "mode" && event.inherited)
      candidates.set(event.scopeId, event.mode);
  }
  if (!candidates.size) return EMPTY_PROGRESS;

  // Snapshot modes coexist by scope. Only explicit commands reset descendants.
  const modes = new Map<string, ReadingMode>();
  for (const id of [BOOK_SCOPE, ...index.sections.map(({ id }) => id)]) {
    const mode = candidates.get(id);
    if (mode !== undefined) modes.set(id, mode);
  }
  return { ...EMPTY_PROGRESS, modes: Object.fromEntries(modes) };
}

export function mergeProgressEvents(
  index: ReadingIndex,
  events: readonly ProgressEvent[],
): ProgressState {
  const samples: ReadingSample[] = [];
  const migrations = new Map<string, ReadingSample>();
  const journal = uniqueEvents(events).sort(compareEvents);
  let state = inheritedState(index, journal);
  for (const event of journal) {
    switch (event.kind) {
      case "observe":
        for (const sample of event.samples) samples.push(sample);
        break;
      case "migrate":
        for (const sample of event.samples)
          mergeMigratedSample(migrations, sample);
        break;
      case "mode":
        if (!event.inherited)
          state = changeMode(index, state, event.scopeId, event.mode);
        break;
      case "visit":
        state = setLastConsultation(index, state, event.position);
        break;
    }
  }
  // Inherited durations may already include readings from another replica.
  return observeReadings(index, state, [...migrations.values(), ...samples]);
}

function uniqueEvents(events: readonly ProgressEvent[]) {
  const unique = new Map<string, ProgressEvent>();
  for (const event of events) {
    if (!event.deviceId) throw new Error("Identifiant d’appareil manquant.");
    if (!Number.isSafeInteger(event.clock) || event.clock < 1)
      throw new RangeError("Valeur d’horloge logique invalide.");
    const identity = JSON.stringify([event.deviceId, event.clock]);
    const previous = unique.get(identity);
    if (!previous) unique.set(identity, event);
    else if (!samePayload(previous, event))
      throw new Error("Événements incompatibles pour la même identité.");
  }
  return [...unique.values()];
}

function compareEvents(left: ProgressEvent, right: ProgressEvent) {
  const inheritanceOrder =
    Number(isInheritedProgressEvent(right)) -
    Number(isInheritedProgressEvent(left));
  if (inheritanceOrder) return inheritanceOrder;
  if (left.clock !== right.clock) return left.clock - right.clock;
  if (left.deviceId === right.deviceId) return 0;
  return left.deviceId < right.deviceId ? -1 : 1;
}

function samePayload(left: ProgressEvent, right: ProgressEvent): boolean {
  if (isInheritedProgressEvent(left) !== isInheritedProgressEvent(right))
    return false;
  switch (left.kind) {
    case "observe":
    case "migrate":
      return (
        right.kind === left.kind && sameSamples(left.samples, right.samples)
      );
    case "mode":
      return (
        right.kind === "mode" &&
        left.scopeId === right.scopeId &&
        left.mode === right.mode
      );
    case "visit":
      return (
        right.kind === "visit" && samePosition(left.position, right.position)
      );
  }
}

function sameSamples(
  left: readonly ReadingSample[],
  right: readonly ReadingSample[],
) {
  return (
    left.length === right.length &&
    left.every((sample, i) => {
      const other = right[i]!;
      return (
        sample.unitId === other.unitId &&
        Object.is(sample.elapsedMs, other.elapsedMs) &&
        Object.is(sample.coverage, other.coverage)
      );
    })
  );
}

function samePosition(left: ReadingPosition, right: ReadingPosition) {
  return (
    left.fragmentId === right.fragmentId &&
    left.blockId === right.blockId &&
    left.anchor === right.anchor
  );
}
