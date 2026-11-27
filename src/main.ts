import "./styles.css";
import { mountBackupPanel } from "./backup/backup-panel";
import { startImportScreen } from "./import-screen";
import { startInstallSupport } from "./install-support";
import { startReader } from "./reader";
import type { startDriveController } from "./sync/drive-controller";
import { registerOfflineWorker } from "./worker-client";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Élément absent : ${id}`);
  return node as T;
}

let drive: ReturnType<typeof startDriveController> | undefined;
const backup = mountBackupPanel(
  element<HTMLDetailsElement>("backup-panel"),
  () => catalog.refresh(),
);
let driveLoading:
  Promise<ReturnType<typeof startDriveController> | undefined> | undefined;

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
    changed: () => {
      void drive?.refreshLocal();
      void backup.refreshBooks();
    },
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
  const driveClient = import.meta.env.VITE_DRIVE_CLIENT_ID as
    string | undefined;
  if (driveClient) {
    const panel = element<HTMLDetailsElement>("drive-panel");
    panel.hidden = false;
    panel.addEventListener("toggle", () => {
      if (!panel.open || driveLoading) return;
      driveLoading = import("./sync/drive-controller")
        .then(({ startDriveController }) => {
          drive = startDriveController(panel, driveClient, catalog.refresh);
          return drive;
        })
        .catch(() => {
          driveLoading = undefined;
          element("drive-status").textContent =
            "Impossible de charger la synchronisation Google Drive.";
          return undefined;
        });
    });
  }
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
      driveLoading?.then((controller) => controller?.settleForUpdate()),
      backup.settleForUpdate(),
    ]).then(([catalogResult, readerResult, driveResult, backupResult]) => {
      function release() {
        preparation = undefined;
        catalog.resumeAfterUpdate();
        if (readerResult.status === "fulfilled") readerResult.value();
        if (driveResult.status === "fulfilled") driveResult.value?.();
        if (backupResult.status === "fulfilled") backupResult.value();
      }
      const outcome = [
        catalogResult,
        readerResult,
        driveResult,
        backupResult,
      ].find((result) => result.status === "rejected");
      if (outcome) {
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
