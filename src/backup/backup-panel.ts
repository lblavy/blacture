import {
  BackupAlreadyPresentError,
  exportBookBackup,
  exportPreviousEdition,
  listBooks,
  removeLocalEdition,
  restoreBookBackup,
} from "../storage";

const invalidArchiveMessage = "Cette sauvegarde est invalide ou incomplète.";

function archiveName(title: string, previous: boolean) {
  const base = title
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, " ")
    .trim()
    .slice(0, 100);
  const suffix = previous ? "edition-precedente" : "sauvegarde";
  return `${base || "Ouvrage"}-${suffix}.blacture`;
}

function download(archive: Blob, title: string, previous: boolean) {
  const url = URL.createObjectURL(archive);
  const link = document.createElement("a");
  link.href = url;
  link.download = archiveName(title, previous);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function mountBackupPanel(
  panel: HTMLDetailsElement,
  onLibraryChanged?: () => void,
) {
  function element<T extends HTMLElement>(name: string): T {
    const target = panel.querySelector<T>(`#backup-${name}`);
    if (!target) throw new Error(`Élément de sauvegarde absent : ${name}`);
    return target;
  }

  const books = element<HTMLSelectElement>("book");
  const file = element<HTMLInputElement>("file");
  const exportButton = element<HTMLButtonElement>("export");
  const previousButton = element<HTMLButtonElement>("previous");
  const removeButton = element<HTMLButtonElement>("remove");
  const inspectButton = element<HTMLButtonElement>("inspect");
  const restoreButton = element<HTMLButtonElement>("restore");
  const cancel = element<HTMLButtonElement>("cancel");
  const status = element("status");
  let operation: AbortController | undefined;
  let pending = Promise.resolve();
  let revision = 0;
  let frozen = false;
  let previousEditions = new Set<string>();

  function updateControls() {
    const busy = Boolean(operation) || frozen;
    books.disabled = busy;
    file.disabled = busy;
    exportButton.disabled = busy || !books.value;
    removeButton.disabled = exportButton.disabled;
    previousButton.hidden = !previousEditions.has(books.value);
    previousButton.disabled = busy || previousButton.hidden;
    inspectButton.disabled = busy || !file.files?.length;
    restoreButton.disabled = inspectButton.disabled;
    cancel.hidden = !operation;
    cancel.disabled = operation?.signal.aborted === true;
  }

  async function refreshBooks() {
    if (!panel.open) return;
    const current = ++revision;
    try {
      const entries = await listBooks();
      if (current !== revision) return;
      const selected = books.value;
      previousEditions = new Set(
        entries
          .filter((entry) => entry.hasPreviousEdition)
          .map((entry) => entry.key),
      );
      const options = entries.map(({ key, title }) => new Option(title, key));
      books.replaceChildren(new Option("Choisir un ouvrage", ""), ...options);
      if (options.some(({ value }) => value === selected))
        books.value = selected;
      updateControls();
    } catch {
      if (!operation && current === revision)
        status.textContent = "Impossible de lire la bibliothèque locale.";
    }
  }

  async function run(
    message: string,
    action: (signal: AbortSignal) => Promise<string>,
    failure: string,
  ) {
    const controller = new AbortController();
    operation = controller;
    status.textContent = message;
    updateControls();
    try {
      status.textContent = await action(controller.signal);
    } catch {
      status.textContent = controller.signal.aborted
        ? "Opération annulée."
        : failure;
    } finally {
      operation = undefined;
      updateControls();
    }
  }

  async function refreshLibrary() {
    onLibraryChanged?.();
    await refreshBooks();
  }

  function startExport(previous: boolean) {
    const key = books.value;
    if (!key || operation || frozen || (previous && !previousEditions.has(key)))
      return;
    pending = run(
      "Préparation de la sauvegarde…",
      async (signal) => {
        const { encodeBookArchive } = await import("./book-archive");
        const readSnapshot = previous
          ? exportPreviousEdition
          : exportBookBackup;
        const snapshot = await readSnapshot(key, signal);
        if (!snapshot) return "Aucune édition précédente à exporter.";
        const archive = await encodeBookArchive(snapshot, signal);
        signal.throwIfAborted();
        download(archive, snapshot.book.title, previous);
        return `Téléchargement de la sauvegarde de « ${snapshot.book.title} » lancé.`;
      },
      "Impossible d’exporter cet ouvrage.",
    );
  }

  exportButton.addEventListener("click", () => startExport(false));
  previousButton.addEventListener("click", () => startExport(true));
  removeButton.addEventListener("click", () => {
    const key = books.value;
    if (!key || operation || frozen) return;
    const title = books.selectedOptions[0]!.label;
    const confirmed = window.confirm(
      `Retirer « ${title} » de cet appareil ?\n\nL’ouvrage, sa progression locale et toute sauvegarde locale de l’édition précédente seront retirés. Les données déjà synchronisées restent dans Google Drive.`,
    );
    if (!confirmed) return;
    pending = run(
      "Retrait local en cours…",
      async (signal) => {
        await removeLocalEdition(key, signal);
        await refreshLibrary();
        return `Ouvrage « ${title} » retiré de cet appareil.`;
      },
      "Impossible de retirer cet ouvrage de l’appareil.",
    );
  });
  inspectButton.addEventListener("click", () => {
    const selected = file.files?.item(0);
    if (!selected || operation || frozen) return;
    pending = run(
      "Vérification de la sauvegarde…",
      async (signal) => {
        const { inspectBookArchive } = await import("./book-archive");
        const info = await inspectBookArchive(selected, signal);
        signal.throwIfAborted();
        const contents = info.hasProgress
          ? "Données de progression présentes."
          : "Aucune donnée de progression.";
        return `Intégrité vérifiée pour « ${info.title} ». ${contents}`;
      },
      invalidArchiveMessage,
    );
  });
  restoreButton.addEventListener("click", () => {
    const selected = file.files?.item(0);
    if (!selected || operation || frozen) return;
    pending = run(
      "Vérification avant restauration…",
      async (signal) => {
        const { decodeBookArchive } = await import("./book-archive");
        const snapshot = await decodeBookArchive(selected, signal);
        signal.throwIfAborted();
        status.textContent = "Restauration locale…";
        try {
          await restoreBookBackup(snapshot, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof BackupAlreadyPresentError)
            return "Cet ouvrage est déjà dans la bibliothèque. La restauration n’a rien modifié.";
          if (
            error instanceof DOMException &&
            error.name === "QuotaExceededError"
          )
            return "Espace de stockage insuffisant pour restaurer cet ouvrage.";
          return "Impossible de restaurer cet ouvrage.";
        }
        await refreshLibrary();
        return `Ouvrage « ${snapshot.book.title} » restauré.`;
      },
      invalidArchiveMessage,
    );
  });
  books.addEventListener("change", updateControls);
  file.addEventListener("change", updateControls);
  panel.addEventListener("toggle", () => void refreshBooks());
  cancel.addEventListener("click", () => {
    operation?.abort();
    updateControls();
  });
  updateControls();

  return {
    refreshBooks,
    async settleForUpdate() {
      frozen = true;
      operation?.abort();
      updateControls();
      await pending;
      return () => {
        frozen = false;
        updateControls();
      };
    },
  };
}
