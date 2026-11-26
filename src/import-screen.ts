import { createFragmentPreview } from "./fragment-preview";
import type { ImportedBook, ImportStage } from "./import";
import { runImport } from "./import-job";
import { listBooks, saveEdition } from "./storage";

interface ImportControls {
  form: HTMLFormElement;
  file: HTMLInputElement;
  submit: HTMLButtonElement;
  cancel: HTMLButtonElement;
  status: HTMLElement;
  diagnostics: HTMLElement;
  catalog: HTMLElement;
  preview: HTMLElement;
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
  services = { runImport, listBooks, saveEdition, createFragmentPreview },
) {
  const { form, file, submit, cancel, status, diagnostics, catalog } = controls;
  const preview = services.createFragmentPreview(controls.preview);
  let active: AbortController | undefined;

  async function refreshCatalog() {
    const start = performance.now();
    const entries = await services.listBooks();
    catalog.replaceChildren();
    for (const entry of entries) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = entry.title;
      button.addEventListener("click", () => {
        const start = performance.now();
        void preview.open(entry).then(
          () => performance.measure("fragment-open", { start }),
          () => {
            status.textContent = "Impossible de lire le premier fragment.";
          },
        );
      });
      item.append(button);
      catalog.append(item);
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
  void refreshCatalog().catch(() => {
    status.textContent = "Impossible de lire le catalogue local.";
  });
}
