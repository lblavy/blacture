import {
  EMPTY_PROGRESS,
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
    | {
        readonly kind: "mode";
        readonly scopeId: string;
        readonly mode: ReadingMode;
      }
    | { readonly kind: "visit"; readonly position: ReadingPosition }
  );

export function mergeProgressEvents(
  index: ReadingIndex,
  events: readonly ProgressEvent[],
): ProgressState {
  let state = EMPTY_PROGRESS;
  const samples: ReadingSample[] = [];
  const journal = uniqueEvents(events).sort(compareEvents);
  for (const event of journal) {
    switch (event.kind) {
      case "observe":
        for (const sample of event.samples) samples.push(sample);
        break;
      case "mode":
        state = changeMode(index, state, event.scopeId, event.mode);
        break;
      case "visit":
        state = setLastConsultation(index, state, event.position);
        break;
    }
  }
  // Observations are independent of corrections and consultation position.
  return observeReadings(index, state, samples);
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
  if (left.clock !== right.clock) return left.clock - right.clock;
  if (left.deviceId === right.deviceId) return 0;
  return left.deviceId < right.deviceId ? -1 : 1;
}

function samePayload(left: ProgressEvent, right: ProgressEvent): boolean {
  switch (left.kind) {
    case "observe":
      return (
        right.kind === "observe" && sameSamples(left.samples, right.samples)
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
