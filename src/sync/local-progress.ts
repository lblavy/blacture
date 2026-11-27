import {
  BOOK_SCOPE,
  FULL_COVERAGE,
  READING_TIME_MS,
  type ProgressState,
  type ReadingSample,
} from "../domain/progress";
import type { ProgressEvent } from "../domain/progress-sync";

type Change<Event extends ProgressEvent> = Event extends ProgressEvent
  ? Omit<Event, "deviceId" | "clock">
  : never;

export type ProgressChange = Change<ProgressEvent>;

export interface ProgressJournal {
  deviceId: string;
  events: ProgressEvent[];
}

export const maxProgressClock = Number.MAX_SAFE_INTEGER - 1;

const maxInitialSamples = 128;

function observations(state: ProgressState): ReadingSample[] {
  const samples: ReadingSample[] = [];
  for (const [unitId, { elapsedMs, coverage }] of Object.entries(
    state.observations,
  )) {
    if (
      Number.isFinite(elapsedMs) &&
      elapsedMs > 0 &&
      Number.isInteger(coverage) &&
      coverage > 0 &&
      coverage <= FULL_COVERAGE
    )
      samples.push({
        unitId,
        elapsedMs: Math.min(elapsedMs, READING_TIME_MS),
        coverage,
      });
  }
  return samples;
}

export function initialProgressChanges(
  state: ProgressState,
  sections: readonly { id: string }[],
  inherited = false,
): ProgressChange[] {
  const changes: ProgressChange[] = [];
  const samples = observations(state);
  for (let start = 0; start < samples.length; start += maxInitialSamples)
    changes.push({
      kind: inherited ? "migrate" : "observe",
      samples: samples.slice(start, start + maxInitialSamples),
    });
  // A command on an ancestor resets its descendants. Replay ancestors first.
  for (const scopeId of [BOOK_SCOPE, ...sections.map(({ id }) => id)]) {
    if (Object.hasOwn(state.modes, scopeId))
      changes.push({
        kind: "mode",
        scopeId,
        mode: state.modes[scopeId]!,
        ...(inherited ? { inherited: true } : {}),
      });
  }
  if (state.last)
    changes.push({
      kind: "visit",
      position: state.last,
      ...(inherited ? { inherited: true } : {}),
    });
  return changes;
}
