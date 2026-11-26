export const BOOK_SCOPE = "@book";
export const READING_TIME_MS = 8_000;
export const FULL_COVERAGE = 0b1111;
export const COMPLETION_RATIO = 0.95;

export type ReadingMode = "auto" | "read" | "unread";
export type ReadingStatus = "empty" | "unstarted" | "partial" | "complete";

export interface ReadingUnit {
  id: string;
  weight: number;
}

export interface ReadingSection {
  id: string;
  parentId: string | null;
  fragmentIds: readonly string[];
}

export interface ReadingIndex {
  /** Canonical pre-order from the edition manifest, with each parent before its descendants. */
  readonly sections: readonly ReadingSection[];
  readonly fragments: Readonly<Record<string, readonly ReadingUnit[]>>;
}

export interface ReadingPosition {
  fragmentId: string;
  blockId?: string;
  anchor?: string;
}

export interface ReadingObservation {
  elapsedMs: number;
  coverage: number;
}

export interface ReadingSample extends ReadingObservation {
  unitId: string;
}

export interface ProgressState {
  observations: Readonly<Record<string, ReadingObservation>>;
  modes: Readonly<Record<string, ReadingMode>>;
  last?: ReadingPosition;
}

export const EMPTY_PROGRESS: ProgressState = Object.freeze({
  observations: Object.freeze({}),
  modes: Object.freeze({}),
});

export interface ReadingSummary {
  status: ReadingStatus;
  percent: number;
  ownWeight: number;
  ownReadWeight: number;
  totalWeight: number;
  readWeight: number;
}

export interface ProgressSummary {
  book: ReadingSummary;
  sections: Record<string, ReadingSummary>;
  firstUnread?: ReadingPosition;
}

interface IndexedUnit extends ReadingUnit {
  fragmentId: string;
  sectionId: string;
}

interface IndexedSection {
  id: string;
  parentId: string;
  units: IndexedUnit[];
  weight: number;
}

interface PreparedIndex {
  sections: Map<string, IndexedSection>;
  children: Map<string, string[]>;
  fragments: Set<string>;
  units: Map<string, IndexedUnit>;
}

const preparedEditions = new WeakMap<ReadingIndex, PreparedIndex>();

function ownValue<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function prepare(index: ReadingIndex): PreparedIndex {
  const existing = preparedEditions.get(index);
  if (existing) return existing;
  const edition: PreparedIndex = {
    sections: new Map(),
    children: new Map(),
    fragments: new Set(),
    units: new Map(),
  };
  for (const section of index.sections) addSection(edition, index, section);
  preparedEditions.set(index, edition);
  return edition;
}

function addSection(
  edition: PreparedIndex,
  index: ReadingIndex,
  section: ReadingSection,
) {
  if (section.id === BOOK_SCOPE || edition.sections.has(section.id)) return;
  const parentId =
    section.parentId !== null && edition.sections.has(section.parentId)
      ? section.parentId
      : BOOK_SCOPE;
  const indexed: IndexedSection = {
    id: section.id,
    parentId,
    units: [],
    weight: 0,
  };
  edition.sections.set(indexed.id, indexed);
  const children = edition.children.get(parentId) ?? [];
  children.push(indexed.id);
  edition.children.set(parentId, children);
  for (const fragmentId of section.fragmentIds) {
    if (edition.fragments.has(fragmentId)) continue;
    edition.fragments.add(fragmentId);
    addUnits(
      edition,
      indexed,
      fragmentId,
      ownValue(index.fragments, fragmentId) ?? [],
    );
  }
}

function addUnits(
  edition: PreparedIndex,
  section: IndexedSection,
  fragmentId: string,
  units: readonly ReadingUnit[],
) {
  for (const unit of units) {
    if (
      !Number.isFinite(unit.weight) ||
      unit.weight <= 0 ||
      edition.units.has(unit.id)
    )
      continue;
    const indexed = { ...unit, sectionId: section.id, fragmentId };
    section.units.push(indexed);
    section.weight += indexed.weight;
    edition.units.set(indexed.id, indexed);
  }
}

function elapsed(value: number) {
  return Number.isFinite(value) && value > 0
    ? Math.min(READING_TIME_MS, value)
    : 0;
}

function coverageMask(value: number) {
  return Number.isSafeInteger(value) && value > 0 ? value & FULL_COVERAGE : 0;
}

export function isUnitComplete(observation?: ReadingObservation): boolean {
  return (
    observation !== undefined &&
    elapsed(observation.elapsedMs) === READING_TIME_MS &&
    coverageMask(observation.coverage) === FULL_COVERAGE
  );
}

function addSample(
  previous: ReadingObservation | undefined,
  sample: ReadingSample,
): ReadingObservation | undefined {
  const duration = elapsed(sample.elapsedMs);
  const mask = coverageMask(sample.coverage);
  if (duration === 0 || mask === 0) return previous;
  const next = {
    elapsedMs: Math.min(
      READING_TIME_MS,
      elapsed(previous?.elapsedMs ?? 0) + duration,
    ),
    coverage: coverageMask(previous?.coverage ?? 0) | mask,
  };
  return previous?.elapsedMs === next.elapsedMs &&
    previous.coverage === next.coverage
    ? previous
    : next;
}

export function observeReadings(
  index: ReadingIndex,
  state: ProgressState,
  samples: readonly ReadingSample[],
): ProgressState {
  const { units } = prepare(index);
  const updates = new Map<string, ReadingObservation>();
  for (const sample of samples) {
    if (!units.has(sample.unitId)) continue;
    const previous =
      updates.get(sample.unitId) ?? ownValue(state.observations, sample.unitId);
    const next = addSample(previous, sample);
    if (next && next !== previous) updates.set(sample.unitId, next);
  }
  if (updates.size === 0) return state;
  return {
    ...state,
    observations: { ...state.observations, ...Object.fromEntries(updates) },
  };
}

export function observeReading(
  index: ReadingIndex,
  state: ProgressState,
  unitId: string,
  elapsedMs: number,
  coverage: number,
): ProgressState {
  return observeReadings(index, state, [{ unitId, elapsedMs, coverage }]);
}

export function changeMode(
  index: ReadingIndex,
  state: ProgressState,
  scopeId: string,
  mode: ReadingMode,
): ProgressState {
  if (scopeId === BOOK_SCOPE)
    return { ...state, modes: { [BOOK_SCOPE]: mode } };
  const { sections, children } = prepare(index);
  if (!sections.has(scopeId)) return state;
  const modes = { ...state.modes, [scopeId]: mode };
  const descendants = [...(children.get(scopeId) ?? [])];
  for (const id of descendants) {
    delete modes[id];
    for (const child of children.get(id) ?? []) descendants.push(child);
  }
  return { ...state, modes };
}

export function setLastConsultation(
  index: ReadingIndex,
  state: ProgressState,
  position: ReadingPosition,
): ProgressState {
  const { fragments, units } = prepare(index);
  if (!fragments.has(position.fragmentId)) return state;
  const last: ReadingPosition = { fragmentId: position.fragmentId };
  if (
    position.blockId &&
    units.get(position.blockId)?.fragmentId === position.fragmentId
  )
    last.blockId = position.blockId;
  if (position.anchor) last.anchor = position.anchor;
  return samePosition(state.last, last) ? state : { ...state, last };
}

function samePosition(
  previous: ReadingPosition | undefined,
  next: ReadingPosition,
) {
  return (
    previous?.fragmentId === next.fragmentId &&
    previous.blockId === next.blockId &&
    previous.anchor === next.anchor
  );
}

interface AutomaticReading {
  started: boolean;
  readWeight: number;
}

function summarizeObservations(edition: PreparedIndex, state: ProgressState) {
  const sections = new Map<string, AutomaticReading>();
  for (const [id, observation] of Object.entries(state.observations)) {
    const unit = edition.units.get(id);
    if (
      !unit ||
      elapsed(observation.elapsedMs) === 0 ||
      coverageMask(observation.coverage) === 0
    )
      continue;
    const reading = sections.get(unit.sectionId) ?? {
      started: true,
      readWeight: 0,
    };
    if (isUnitComplete(observation)) reading.readWeight += unit.weight;
    sections.set(unit.sectionId, reading);
  }
  return sections;
}

interface AccumulatedReading {
  mode: ReadingMode;
  started: boolean;
  ownWeight: number;
  ownReadWeight: number;
  totalWeight: number;
  readWeight: number;
  incompleteChild: boolean;
}

function explicitMode(
  modes: ProgressState["modes"],
  id: string,
): ReadingMode | undefined {
  const explicit = ownValue(modes, id);
  return explicit === "auto" || explicit === "read" || explicit === "unread"
    ? explicit
    : undefined;
}

export function effectiveMode(
  index: ReadingIndex,
  state: ProgressState,
  scopeId: string,
): ReadingMode {
  const { sections } = prepare(index);
  for (
    let section = sections.get(scopeId);
    section;
    section = sections.get(section.parentId)
  ) {
    const mode = explicitMode(state.modes, section.id);
    if (mode) return mode;
  }
  return explicitMode(state.modes, BOOK_SCOPE) ?? "auto";
}

function ownReading(
  mode: ReadingMode,
  weight: number,
  automatic?: AutomaticReading,
): AccumulatedReading {
  const readWeight =
    mode === "read"
      ? weight
      : mode === "auto"
        ? (automatic?.readWeight ?? 0)
        : 0;
  const started =
    readWeight > 0 || (mode === "auto" && automatic?.started === true);
  return {
    mode,
    started,
    ownWeight: weight,
    ownReadWeight: readWeight,
    totalWeight: weight,
    readWeight,
    incompleteChild: false,
  };
}

function ownComplete(reading: AccumulatedReading) {
  return (
    reading.ownWeight === 0 ||
    reading.ownReadWeight >= COMPLETION_RATIO * reading.ownWeight
  );
}

function stateOf(reading: AccumulatedReading): ReadingStatus {
  if (reading.totalWeight === 0) return "empty";
  if (ownComplete(reading) && !reading.incompleteChild) return "complete";
  return reading.started ? "partial" : "unstarted";
}

function presentSummary(reading: AccumulatedReading): ReadingSummary {
  const { ownWeight, ownReadWeight, totalWeight, readWeight } = reading;
  const status = stateOf(reading);
  const percent =
    status === "complete"
      ? 100
      : totalWeight > 0
        ? Math.min(99, Math.floor((100 * readWeight) / totalWeight))
        : 0;
  return { status, percent, ownWeight, ownReadWeight, totalWeight, readWeight };
}

function addChild(parent: AccumulatedReading, child: AccumulatedReading) {
  parent.started ||= child.started;
  parent.totalWeight += child.totalWeight;
  parent.readWeight += child.readWeight;
  parent.incompleteChild ||=
    child.totalWeight > 0 && stateOf(child) !== "complete";
}

function findFirstUnread(
  section: IndexedSection,
  reading: AccumulatedReading,
  observations: ProgressState["observations"],
): ReadingPosition | undefined {
  if (ownComplete(reading)) return undefined;
  const unit = section.units.find(
    ({ id }) =>
      reading.mode === "unread" || !isUnitComplete(ownValue(observations, id)),
  );
  return unit && { fragmentId: unit.fragmentId, blockId: unit.id };
}

export function summarizeProgress(
  index: ReadingIndex,
  state: ProgressState,
): ProgressSummary {
  const edition = prepare(index);
  const automatic = summarizeObservations(edition, state);
  const book = ownReading(explicitMode(state.modes, BOOK_SCOPE) ?? "auto", 0);
  const readings = new Map([[BOOK_SCOPE, book]]);
  let firstUnread: ReadingPosition | undefined;
  for (const section of edition.sections.values()) {
    const parent = readings.get(section.parentId)!;
    const reading = ownReading(
      explicitMode(state.modes, section.id) ?? parent.mode,
      section.weight,
      automatic.get(section.id),
    );
    readings.set(section.id, reading);
    firstUnread ??= findFirstUnread(section, reading, state.observations);
  }
  for (const section of [...edition.sections.values()].reverse()) {
    addChild(readings.get(section.parentId)!, readings.get(section.id)!);
  }
  readings.delete(BOOK_SCOPE);
  const sections = Object.fromEntries(
    Array.from(
      readings,
      ([id, reading]) => [id, presentSummary(reading)] as const,
    ),
  );
  return {
    book: presentSummary(book),
    sections,
    ...(firstUnread ? { firstUnread } : {}),
  };
}
