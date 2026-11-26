import type { ImportedBook, ImportStage } from "./import";
import { runImport } from "./import-job";
import { progressLabel, type ResumeKind } from "./reader/progress-session";
import { listBooks, saveEdition, type CatalogEntry } from "./storage";

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

export function startImportScreen(
  controls: ImportControls,
  actions: LibraryActions,
  services = { runImport, listBooks, saveEdition },
) {
  const { form, file, submit, cancel, status, diagnostics, catalog, empty } =
    controls;
  let active: AbortController | undefined;

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
  }

  function updateControls(busy: boolean) {
    submit.disabled = busy;
    file.disabled = busy;
    cancel.hidden = !busy;
  }

  async function persistMarkdown(source: File, signal: AbortSignal) {
    const start = performance.now();
    const book = await services.runImport(source, signal, (stage) => {
      status.textContent = stageText[stage];
      performance.mark(`import-${stage}`);
    });
    showDiagnostics(diagnostics, book.diagnostics);
    performance.measure("import-analysis", { start });
    if (book.diagnostics.some(({ severity }) => severity === "error")) {
      status.textContent = "Import arrêté. Consulte les diagnostics.";
      return;
    }
    status.textContent = "Enregistrement local…";
    const writeStart = performance.now();
    await services.saveEdition(book, signal);
    performance.measure("import-write", { start: writeStart });
    form.reset();
    status.textContent = "Import terminé.";
    await refreshCatalog();
    performance.measure("import-total", { start });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const selected = file.files?.item(0);
    if (!selected || active) return;
    const controller = new AbortController();
    active = controller;
    updateControls(true);
    showDiagnostics(diagnostics, []);
    status.textContent = "Préparation de l’import…";
    void persistMarkdown(selected, controller.signal)
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Import impossible.";
        status.textContent = controller.signal.aborted
          ? "Import annulé."
          : message;
      })
      .finally(() => {
        active = undefined;
        updateControls(false);
      });
  });

  cancel.addEventListener("click", () => active?.abort());
  function refresh() {
    void refreshCatalog().catch(() => {
      status.textContent = "Impossible de lire le catalogue local.";
    });
  }
  refresh();
  return { refresh };
}
