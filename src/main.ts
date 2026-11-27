import "./styles.css";
import { startImportScreen } from "./import-screen";
import { startInstallSupport } from "./install-support";
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
  startInstallSupport({
    installButton: element<HTMLButtonElement>("install-app"),
    installStatus: element("install-status"),
    persistButton: element<HTMLButtonElement>("request-persistence"),
    persistStatus: element("persistence-status"),
  });
  let preparation: Promise<() => void> | undefined;
  function prepareUpdate() {
    preparation ??= Promise.allSettled([
      catalog.prepareUpdate(),
      reader.prepareUpdate(),
    ]).then(([catalogResult, readerResult]) => {
      function release() {
        preparation = undefined;
        catalog.resumeAfterUpdate();
        if (readerResult.status === "fulfilled") readerResult.value();
      }
      const outcome =
        catalogResult.status === "rejected" ? catalogResult : readerResult;
      if (outcome.status === "rejected") {
        release();
        throw outcome.reason;
      }
      return release;
    });
    return preparation;
  }
  void registerOfflineWorker(
    element("offline-status"),
    element<HTMLButtonElement>("update"),
    prepareUpdate,
    undefined,
    () => {
      reader.preservePositionForReload();
      window.location.reload();
    },
  );
}
