import {
  BOOK_SCOPE,
  changeMode,
  effectiveMode,
  isUnitComplete,
  observeReading,
  setLastConsultation,
  summarizeProgress,
  type ProgressState,
  type ReadingIndex,
  type ReadingMode,
  type ReadingPosition,
} from "../domain/progress";
import {
  readManifest,
  readProgress,
  readReadingIndex,
  updateProgress,
  type CatalogEntry,
  type CatalogProgress,
  type Manifest,
} from "../storage";
import { watchReading, type ReadingSample } from "./reading-observer";

export interface ProgressControls {
  toolbar: HTMLElement;
  contents: HTMLElement;
  bookState: HTMLElement;
  sectionState: HTMLElement;
  bookMode: HTMLSelectElement;
  sectionMode: HTMLSelectElement;
  error: HTMLElement;
}

interface Passage {
  key: string;
  manifest: Manifest;
  section: string;
  position: ReadingPosition;
}

type Summary = ReturnType<typeof summarizeProgress>;

interface BookProgress {
  key: string;
  index: ReadingIndex;
  state: ProgressState;
  summary: Summary;
}

export type ResumeKind = "last" | "progress";

const labels = {
  empty: "Aucun passage à suivre",
  unstarted: "Non commencé",
  partial: "En cours",
  complete: "Terminé",
};

export function progressLabel(
  value: Pick<CatalogProgress, "status" | "percent">,
) {
  const label = labels[value.status];
  return value.status === "partial" ? `${label} · ${value.percent} %` : label;
}

function setText(element: HTMLElement, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function samePosition(a: ReadingPosition | undefined, b: ReadingPosition) {
  return (
    a?.fragmentId === b.fragmentId &&
    a.blockId === b.blockId &&
    a.anchor === b.anchor
  );
}

export function createProgressSession(
  controls: ProgressControls,
  publish: (summary: Summary) => void,
) {
  const listeners = new AbortController();
  let current: Passage | undefined;
  let ready: BookProgress | undefined;
  let loading: { key: string; controller: AbortController } | undefined;
  let unwatch: (() => void) | undefined;
  let writes = Promise.resolve();

  function applySummary(session: BookProgress, passage: Passage) {
    setText(controls.bookState, progressLabel(session.summary.book));
    const section = session.summary.sections[passage.section];
    setText(controls.sectionState, section ? progressLabel(section) : "");
    controls.bookMode.value = effectiveMode(
      session.index,
      session.state,
      BOOK_SCOPE,
    );
    controls.sectionMode.value = effectiveMode(
      session.index,
      session.state,
      passage.section,
    );
    controls.bookMode.disabled = false;
    controls.sectionMode.disabled = !section;
    publish(session.summary);
  }

  function save(
    session: BookProgress,
    change: (state: ProgressState) => ProgressState,
    refreshSummary = false,
  ) {
    writes = writes
      .then(async () => {
        let summary: Summary | undefined;
        session.state = await updateProgress(
          session.key,
          (previous, previousSummary) => {
            const state = change(previous);
            if (state === previous && !refreshSummary) return { state };
            summary = summarizeProgress(session.index, state);
            const { status, percent } = summary.book;
            const hasLast = Boolean(state.last);
            if (
              status === previousSummary?.status &&
              percent === previousSummary.percent &&
              hasLast === previousSummary.hasLast
            )
              return { state };
            return { state, summary: { status, percent, hasLast } };
          },
        );
        if (summary) session.summary = summary;
        if (ready === session && current?.key === session.key) {
          setText(controls.error, "");
          applySummary(session, current);
        }
      })
      .catch(() => {
        if (ready === session)
          controls.error.textContent =
            "Impossible d’enregistrer la progression locale.";
      });
  }

  function observe(
    session: BookProgress,
    passage: Passage,
    sample: ReadingSample,
  ) {
    const position = {
      fragmentId: passage.position.fragmentId,
      blockId: sample.id,
    };
    const prior = session.state.observations[sample.id];
    const unchanged =
      session.state.last?.fragmentId === position.fragmentId &&
      session.state.last.blockId === sample.id;
    if (unchanged && (sample.elapsedMs === 0 || isUnitComplete(prior))) return;
    save(session, (state) => {
      const positioned = setLastConsultation(session.index, state, position);
      return observeReading(
        session.index,
        positioned,
        sample.id,
        sample.elapsedMs,
        sample.coverage,
      );
    });
  }

  function activate(session: BookProgress, passage: Passage) {
    applySummary(session, passage);
    save(
      session,
      (state) => setLastConsultation(session.index, state, passage.position),
      true,
    );
    const units = session.index.fragments[passage.position.fragmentId] ?? [];
    if (units.length > 0) {
      unwatch = watchReading(
        controls.contents,
        controls.toolbar,
        units,
        (sample) => observe(session, passage, sample),
      );
    }
  }

  function rememberWhileIndexing(passage: Passage) {
    writes = writes
      .then(async () => {
        await updateProgress(passage.key, (state, summary) => {
          if (samePosition(state.last, passage.position)) return { state };
          return {
            state: { ...state, last: passage.position },
            summary: {
              status: summary?.status ?? "unstarted",
              percent: summary?.percent ?? 0,
              hasLast: true,
            },
          };
        });
      })
      .catch(() => {
        if (current?.key === passage.key)
          setText(
            controls.error,
            "Impossible d’enregistrer la dernière consultation.",
          );
      });
  }

  function pause() {
    unwatch?.();
    unwatch = undefined;
    current = undefined;
    controls.bookMode.disabled = true;
    controls.sectionMode.disabled = true;
  }

  function close() {
    pause();
    loading?.controller.abort();
    loading = undefined;
    ready = undefined;
    setText(controls.error, "");
  }

  function show(passage: Passage) {
    pause();
    current = passage;
    if (ready?.key === passage.key) {
      activate(ready, passage);
      return;
    }
    rememberWhileIndexing(passage);
    if (loading?.key === passage.key) return;
    loading?.controller.abort();
    ready = undefined;
    setText(controls.bookState, "Préparation de la progression…");
    setText(controls.sectionState, "");
    setText(controls.error, "");
    const controller = new AbortController();
    loading = { key: passage.key, controller };
    const signal = controller.signal;
    void Promise.all([
      readReadingIndex(passage.key, passage.manifest, signal),
      writes.then(() => readProgress(passage.key, signal)),
    ])
      .then(([index, state]) => {
        if (signal.aborted) return;
        ready = {
          key: passage.key,
          index,
          state,
          summary: summarizeProgress(index, state),
        };
        if (current?.key === passage.key) activate(ready, current);
      })
      .catch(() => {
        if (!signal.aborted)
          setText(
            controls.bookState,
            "Progression indisponible pour cet ouvrage.",
          );
      })
      .finally(() => {
        if (loading?.controller === controller) loading = undefined;
      });
  }

  function setMode(scope: string | undefined, value: string) {
    const session = ready;
    if (!session || !scope || !["auto", "read", "unread"].includes(value))
      return;
    save(session, (state) =>
      changeMode(session.index, state, scope, value as ReadingMode),
    );
  }

  controls.bookMode.addEventListener(
    "change",
    () => setMode(BOOK_SCOPE, controls.bookMode.value),
    { signal: listeners.signal },
  );
  controls.sectionMode.addEventListener(
    "change",
    () => setMode(current?.section, controls.sectionMode.value),
    { signal: listeners.signal },
  );

  async function resume(
    entry: CatalogEntry,
    kind: ResumeKind,
    signal?: AbortSignal,
  ): Promise<ReadingPosition> {
    await writes;
    const state = await readProgress(entry.key, signal);
    if (kind === "last") {
      if (!state.last) throw new Error("Aucune consultation enregistrée.");
      return state.last;
    }
    const manifest = await readManifest(entry.key, signal);
    if (!manifest) throw new Error("Ouvrage indisponible sur cet appareil.");
    const index = await readReadingIndex(entry.key, manifest, signal);
    const position = summarizeProgress(index, state).firstUnread;
    if (!position) throw new Error("Aucun passage restant à lire.");
    return position;
  }

  return {
    show,
    pause,
    close,
    resume,
    settled: () => writes,
    dispose() {
      listeners.abort();
      close();
    },
  };
}
