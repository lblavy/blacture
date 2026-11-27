import type { ImportedBook, ImportStage } from "./import";
import { runImport } from "./import-job";
import { progressLabel, type ResumeKind } from "./reader/progress-session";
import {
  listBooks,
  replaceEdition,
  saveEdition,
  type CatalogEntry,
} from "./storage";

interface ImportControls {
  form: HTMLFormElement;
  file: HTMLInputElement;
  submit: HTMLButtonElement;
  cancel: HTMLButtonElement;
  status: HTMLElement;
  diagnostics: HTMLElement;
  catalog: HTMLElement;
  empty: HTMLElement;
}

interface LibraryActions {
  open: (entry: CatalogEntry) => Promise<void>;
  resume: (entry: CatalogEntry, kind: ResumeKind) => Promise<void>;
  changed?: () => void;
}

const stageText: Record<ImportStage, string> = {
  parse: "Analyse du Markdown…",
  resources: "Extraction des images…",
  assemble: "Préparation des fragments…",
};

const diagnosticText = new Map([
  ["duplicate-anchor", "Identifiant d’ancre en double"],
  ["unresolved-anchor", "Destination interne introuvable"],
  ["empty-document", "Document sans contenu importable"],
  ["missing-resource", "Image absente ou non prise en charge"],
  ["presentation-simplified", "Mise en forme simplifiée"],
  ["unsupported-heading-attribute", "Attribut de titre non pris en charge"],
  ["unmatched-container-marker", "Délimiteur de conteneur sans paire"],
  ["unsupported-container-marker", "Syntaxe de conteneur non prise en charge"],
  ["unsupported-attribute", "Attribut non pris en charge"],
  ["unsupported-link", "Lien non pris en charge"],
  ["unsupported-markup", "Balise non prise en charge"],
  ["unsafe-markup", "Contenu actif écarté"],
]);

function showDiagnostics(
  target: HTMLElement,
  diagnostics: ImportedBook["diagnostics"],
) {
  target.replaceChildren();
  target.hidden = diagnostics.length === 0;
  for (const { code, severity, count } of diagnostics) {
    const item = document.createElement("li");
    const label = severity === "error" ? "Bloquant" : "Avertissement";
    item.textContent = `${label} · ${diagnosticText.get(code) ?? code} (${count})`;
    target.append(item);
  }
}

function importErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "QuotaExceededError")
    return "Espace de stockage insuffisant pour importer cet ouvrage.";
  return error instanceof Error ? error.message : "Import impossible.";
}

function replacementMessage({
  replaced,
  omitted,
}: {
  replaced: boolean;
  omitted: number;
}) {
  if (!replaced) return "Cette édition est déjà à jour.";
  const completed =
    "Ouvrage remplacé. L’édition précédente est disponible dans Sauvegarde locale.";
  if (omitted === 1)
    return `${completed} 1 élément du suivi reste dans la sauvegarde.`;
  if (omitted > 1)
    return `${completed} ${omitted} éléments du suivi restent dans la sauvegarde.`;
  return completed;
}

export function startImportScreen(
  controls: ImportControls,
  actions: LibraryActions,
  services = { runImport, listBooks, saveEdition, replaceEdition },
) {
  const { form, file, submit, cancel, status, diagnostics, catalog, empty } =
    controls;
  const replacement = form.querySelector<HTMLSelectElement>(
    "#import-replacement",
  )!;
  const replacementField = form.querySelector<HTMLElement>(
    "#import-replacement-field",
  )!;
  const previousNote = form.querySelector<HTMLElement>(
    "#import-previous-note",
  )!;
  let active: AbortController | undefined;
  let importing = Promise.resolve();
  let updating = false;
  let importFailed = false;

  function refreshReplacements(entries: readonly CatalogEntry[]) {
    const selected = replacement.value;
    const options = entries.map(({ key, title, hasPreviousEdition }) => {
      const option = new Option(title, key);
      if (hasPreviousEdition) option.dataset.previous = "yes";
      return option;
    });
    replacement.replaceChildren(
      new Option("Ajouter à la bibliothèque", ""),
      ...options,
    );
    if (options.some(({ value }) => value === selected))
      replacement.value = selected;
    replacementField.hidden = entries.length === 0;
    updateControls();
  }

  function bookButton(entry: CatalogEntry, label: string, kind?: ResumeKind) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.bookKey = entry.key;
    button.dataset.bookAction = kind ?? "open";
    button.addEventListener("click", () => {
      const opened = kind ? actions.resume(entry, kind) : actions.open(entry);
      void opened.catch((error: unknown) => {
        status.textContent =
          kind && error instanceof Error
            ? error.message
            : "Impossible d’ouvrir cet ouvrage.";
      });
    });
    return button;
  }

  function bookItem(entry: CatalogEntry) {
    const item = document.createElement("li");
    item.append(bookButton(entry, entry.title));
    const state = document.createElement("small");
    state.className = "catalog-progress";
    state.textContent = progressLabel(
      entry.progress ?? { status: "unstarted", percent: 0 },
    );
    item.append(state);
    if (entry.progress?.hasLast) {
      const resume = document.createElement("div");
      resume.className = "catalog-resume";
      resume.append(bookButton(entry, "Dernière consultation", "last"));
      if (
        entry.progress.status !== "complete" &&
        entry.progress.status !== "empty"
      ) {
        resume.append(
          bookButton(entry, "Continuer ma progression", "progress"),
        );
      }
      item.append(resume);
    }
    return item;
  }

  async function refreshCatalog() {
    const start = performance.now();
    const entries = await services.listBooks();
    refreshReplacements(entries);
    const focused = document.activeElement;
    const previous =
      focused instanceof HTMLElement && catalog.contains(focused)
        ? focused.dataset
        : undefined;
    catalog.replaceChildren(...entries.map(bookItem));
    empty.hidden = entries.length > 0;
    if (previous?.bookKey) {
      const candidates = Array.from(catalog.querySelectorAll("button")).filter(
        (button) => button.dataset.bookKey === previous.bookKey,
      );
      const sameAction = candidates.find(
        (button) => button.dataset.bookAction === previous.bookAction,
      );
      (sameAction ?? candidates[0])?.focus();
    }
    performance.measure("catalog-open", { start });
    actions.changed?.();
  }

  function updateControls() {
    const busy = Boolean(active);
    submit.disabled = busy || updating;
    file.disabled = busy || updating;
    replacement.disabled = busy || updating;
    previousNote.hidden =
      replacement.selectedOptions[0]?.dataset.previous !== "yes";
    submit.textContent = replacement.value ? "Remplacer l’ouvrage" : "Importer";
    cancel.hidden = !busy;
    catalog.inert = updating;
  }

  async function persistMarkdown(
    source: File,
    target: string,
    signal: AbortSignal,
  ) {
    const start = performance.now();
    const book = await services.runImport(source, signal, (stage) => {
      status.textContent = stageText[stage];
      performance.mark(`import-${stage}`);
    });
    showDiagnostics(diagnostics, book.diagnostics);
    performance.measure("import-analysis", { start });
    if (book.diagnostics.some(({ severity }) => severity === "error")) {
      importFailed = true;
      status.textContent = "Import arrêté. Consulte les diagnostics.";
      return;
    }
    status.textContent = "Enregistrement local…";
    const writeStart = performance.now();
    let result = "Import terminé.";
    if (target) {
      result = replacementMessage(
        await services.replaceEdition(target, book, signal),
      );
    } else {
      await services.saveEdition(book, signal);
    }
    performance.measure("import-write", { start: writeStart });
    form.reset();
    status.textContent = result;
    await refreshCatalog().catch(() => {
      status.textContent =
        "Import enregistré. Impossible de rafraîchir le catalogue.";
    });
    performance.measure("import-total", { start });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = file.files?.item(0);
    if (!selected || active || updating) return;
    const controller = new AbortController();
    active = controller;
    importFailed = false;
    updateControls();
    showDiagnostics(diagnostics, []);
    status.textContent = "Préparation de l’import…";
    importing = persistMarkdown(selected, replacement.value, controller.signal)
      .catch((error: unknown) => {
        importFailed = !controller.signal.aborted;
        status.textContent = controller.signal.aborted
          ? "Import annulé."
          : importErrorMessage(error);
      })
      .finally(() => {
        active = undefined;
        updateControls();
      });
  });

  cancel.addEventListener("click", () => active?.abort());
  replacement.addEventListener("change", updateControls);
  function refresh() {
    void refreshCatalog().catch(() => {
      status.textContent = "Impossible de lire le catalogue local.";
    });
  }
  refresh();
  return {
    refresh,
    async prepareUpdate() {
      const waitingForImport = Boolean(active);
      updating = true;
      updateControls();
      await importing;
      if (waitingForImport && importFailed)
        throw new Error("L’import en cours a échoué.");
    },
    resumeAfterUpdate() {
      updating = false;
      updateControls();
    },
  };
}
