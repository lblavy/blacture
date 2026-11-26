import "./styles.css";
import { startImportScreen } from "./import-screen";
import { startReader } from "./reader";
import { registerOfflineWorker } from "./worker-client";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Élément absent : ${id}`);
  return node as T;
}

const catalog = startImportScreen(
  {
    form: element<HTMLFormElement>("import-form"),
    file: element<HTMLInputElement>("markdown-file"),
    submit: element<HTMLButtonElement>("import-submit"),
    cancel: element<HTMLButtonElement>("import-cancel"),
    status: element("import-status"),
    diagnostics: element("import-diagnostics"),
    catalog: element("catalog"),
    empty: element("catalog-empty"),
  },
  {
    open: (entry) => reader.open(entry),
    resume: (entry, kind) => reader.resume(entry, kind),
  },
);

const contents = element("fragment-preview");
const reader = startReader(
  {
    library: element("library"),
    panel: element("reader"),
    heading: element("reader-title"),
    contents,
    outline: element("reader-toc"),
    outlinePanel: element<HTMLDetailsElement>("reader-toc-panel"),
    fontSize: element<HTMLSelectElement>("reader-font-size"),
    previous: element<HTMLButtonElement>("reader-previous"),
    next: element<HTMLButtonElement>("reader-next"),
    returnToLibrary: element<HTMLButtonElement>("reader-back"),
    returnToReference: element<HTMLButtonElement>("reader-return"),
    status: element("reader-status"),
    progress: {
      toolbar: element("reader-toolbar"),
      contents,
      bookState: element("reader-progress-state"),
      sectionState: element("reader-section-progress"),
      bookMode: element<HTMLSelectElement>("reader-book-mode"),
      sectionMode: element<HTMLSelectElement>("reader-section-mode"),
      error: element("reader-progress-error"),
    },
  },
  catalog.refresh,
);

if (import.meta.env.PROD) {
  void registerOfflineWorker(
    element("offline-status"),
    element<HTMLButtonElement>("update"),
  );
}
