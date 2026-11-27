import { afterEach, expect, it, vi } from "vitest";
import { mountBackupPanel } from "../src/backup/backup-panel";
import html from "../index.html?raw";

const {
  listBooks,
  exportBookBackup,
  exportPreviousEdition,
  removeLocalEdition,
  restoreBookBackup,
  encodeBookArchive,
  inspectBookArchive,
  decodeBookArchive,
  BackupAlreadyPresentError,
} = vi.hoisted(() => ({
  listBooks: vi.fn(),
  exportBookBackup: vi.fn(),
  exportPreviousEdition: vi.fn(),
  removeLocalEdition: vi.fn(),
  restoreBookBackup: vi.fn(),
  encodeBookArchive: vi.fn(),
  inspectBookArchive: vi.fn(),
  decodeBookArchive: vi.fn(),
  BackupAlreadyPresentError: class extends Error {},
}));
vi.mock("../src/storage", () => ({
  listBooks,
  exportBookBackup,
  exportPreviousEdition,
  removeLocalEdition,
  restoreBookBackup,
  BackupAlreadyPresentError,
}));
vi.mock("../src/backup/book-archive", () => ({
  encodeBookArchive,
  inspectBookArchive,
  decodeBookArchive,
}));

const entry = { key: "one", title: "Carnet / histoire ?" };
const snapshot = { book: { title: entry.title } };

function setup(onRestored?: () => void) {
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  const details = document.querySelector<HTMLDetailsElement>("#backup-panel")!;
  const books = details.querySelector<HTMLSelectElement>("#backup-book")!;
  const file = details.querySelector<HTMLInputElement>("#backup-file")!;
  const button = (id: string) => details.querySelector<HTMLButtonElement>(id)!;
  const status = details.querySelector("#backup-status")!;
  listBooks.mockResolvedValue([entry]);
  const panel = mountBackupPanel(details, onRestored);
  const pickBook = async () => {
    details.open = true;
    await panel.refreshBooks();
    books.value = entry.key;
    books.dispatchEvent(new Event("change"));
  };
  const pickFile = () => {
    const selected = new File(["témoin"], "sauvegarde.blacture");
    Object.defineProperty(file, "files", {
      value: { item: () => selected, length: 1 },
      configurable: true,
    });
    file.dispatchEvent(new Event("change"));
    return selected;
  };
  return { panel, details, books, file, button, status, pickBook, pickFile };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function mockDownload() {
  encodeBookArchive.mockResolvedValue(new Blob());
  const createObjectURL = vi.fn().mockReturnValue("blob:archive");
  const revokeObjectURL = vi.fn();
  class ArchiveURL extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", ArchiveURL);
  vi.useFakeTimers();
  const saved = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved(this.download);
  });
  return { saved, revokeObjectURL };
}

it("exporte l’ouvrage sélectionné avec un nom de fichier sûr", async () => {
  const view = setup();
  exportBookBackup.mockResolvedValue(snapshot);
  const { saved, revokeObjectURL } = mockDownload();
  await view.pickBook();
  view.button("#backup-export").click();
  await view.panel.settleForUpdate().then((release) => {
    release();
  });
  expect(view.status.textContent).toBe("Opération annulée.");
  view.button("#backup-export").click();
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledWith("Carnet   histoire-sauvegarde.blacture"),
  );
  expect(encodeBookArchive).toHaveBeenCalledWith(
    snapshot,
    expect.any(AbortSignal),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:archive");
});

it("permet d’exporter l’édition précédente quand elle a été conservée", async () => {
  const view = setup();
  const previous = view.button("#backup-previous");
  expect(previous.hidden).toBe(true);
  await view.pickBook();
  expect(previous.hidden).toBe(true);

  listBooks.mockResolvedValue([{ ...entry, hasPreviousEdition: true }]);
  await view.panel.refreshBooks();
  expect(previous.hidden).toBe(false);
  exportPreviousEdition.mockResolvedValueOnce(snapshot);
  const { saved } = mockDownload();
  previous.click();
  await vi.waitFor(() =>
    expect(saved).toHaveBeenCalledWith(
      "Carnet   histoire-edition-precedente.blacture",
    ),
  );
  expect(exportPreviousEdition).toHaveBeenCalledWith(
    entry.key,
    expect.any(AbortSignal),
  );
  expect(exportBookBackup).not.toHaveBeenCalled();
});

it("vérifie un fichier sans catalogue et signale une archive invalide", async () => {
  const view = setup();
  const file = view.pickFile();
  inspectBookArchive.mockResolvedValueOnce({
    title: "Témoin",
    hasProgress: true,
  });
  inspectBookArchive.mockRejectedValueOnce(new Error("invalide"));
  const verify = view.button("#backup-inspect");
  verify.click();
  await vi.waitFor(() =>
    expect(view.status.textContent).toContain(
      "Données de progression présentes",
    ),
  );
  expect(inspectBookArchive).toHaveBeenCalledWith(
    file,
    expect.any(AbortSignal),
  );
  expect(listBooks).not.toHaveBeenCalled();
  verify.click();
  await vi.waitFor(() =>
    expect(view.status.textContent).toContain("invalide ou incomplète"),
  );
  expect(view.file.disabled).toBe(false);
});

it("restaure seulement après validation puis rafraîchit la bibliothèque", async () => {
  const onRestored = vi.fn();
  const view = setup(onRestored);
  const restore = view.button("#backup-restore");
  expect(restore.disabled).toBe(true);
  const selected = view.pickFile();
  decodeBookArchive.mockRejectedValueOnce(new Error("invalide"));
  decodeBookArchive.mockResolvedValueOnce(snapshot);
  restore.click();
  await vi.waitFor(() =>
    expect(view.status.textContent).toContain("invalide ou incomplète"),
  );
  expect(restoreBookBackup).not.toHaveBeenCalled();
  expect(onRestored).not.toHaveBeenCalled();
  restore.click();
  await vi.waitFor(() => expect(view.status.textContent).toContain("restauré"));
  expect(decodeBookArchive).toHaveBeenCalledWith(
    selected,
    expect.any(AbortSignal),
  );
  expect(restoreBookBackup).toHaveBeenCalledWith(
    snapshot,
    expect.any(AbortSignal),
  );
  expect(onRestored).toHaveBeenCalledOnce();
});

it("conserve l’ouvrage existant et explique le refus de la restauration", async () => {
  const onRestored = vi.fn();
  const view = setup(onRestored);
  view.pickFile();
  decodeBookArchive.mockResolvedValue(snapshot);
  restoreBookBackup.mockRejectedValue(new BackupAlreadyPresentError());
  view.button("#backup-restore").click();
  await vi.waitFor(() =>
    expect(view.status.textContent).toContain("déjà dans la bibliothèque"),
  );
  expect(onRestored).not.toHaveBeenCalled();
});

it.each([
  [
    new DOMException("quota", "QuotaExceededError"),
    "Espace de stockage insuffisant",
  ],
  [new Error("écriture interrompue"), "Impossible de restaurer cet ouvrage"],
])(
  "signale un défaut d’écriture et rend les commandes disponibles (%#)",
  async (error, message) => {
    const onRestored = vi.fn();
    const view = setup(onRestored);
    view.pickFile();
    decodeBookArchive.mockResolvedValue(snapshot);
    restoreBookBackup.mockRejectedValue(error);
    view.button("#backup-restore").click();
    await vi.waitFor(() => expect(view.status.textContent).toContain(message));
    expect(onRestored).not.toHaveBeenCalled();
    expect(view.file.disabled).toBe(false);
  },
);

it("retire l’ouvrage sélectionné seulement après confirmation et rafraîchit la bibliothèque", async () => {
  const onLibraryChanged = vi.fn();
  const view = setup(onLibraryChanged);
  const remove = view.button("#backup-remove");
  const confirm = vi
    .spyOn(window, "confirm")
    .mockReturnValueOnce(false)
    .mockReturnValueOnce(true);
  expect(remove.disabled).toBe(true);
  await view.pickBook();

  remove.click();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining(entry.title));
  expect(confirm).toHaveBeenCalledWith(
    expect.stringMatching(
      /progression locale.+édition précédente.+Google Drive/su,
    ),
  );
  expect(removeLocalEdition).not.toHaveBeenCalled();
  expect(onLibraryChanged).not.toHaveBeenCalled();
  expect(view.books.value).toBe(entry.key);

  listBooks.mockResolvedValue([]);
  remove.click();
  await vi.waitFor(() =>
    expect(view.status.textContent).toContain("retiré de cet appareil"),
  );
  expect(removeLocalEdition).toHaveBeenCalledExactlyOnceWith(
    entry.key,
    expect.any(AbortSignal),
  );
  expect(onLibraryChanged).toHaveBeenCalledOnce();
  expect(view.books.value).toBe("");
  expect(remove.disabled).toBe(true);
});

it("garde la sélection et signale un retrait qui échoue", async () => {
  const onLibraryChanged = vi.fn();
  const view = setup(onLibraryChanged);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  removeLocalEdition.mockRejectedValueOnce(new Error("écriture interrompue"));
  await view.pickBook();
  const remove = view.button("#backup-remove");
  remove.click();
  await vi.waitFor(() =>
    expect(view.status.textContent).toContain("Impossible de retirer"),
  );
  expect(onLibraryChanged).not.toHaveBeenCalled();
  expect(view.books.value).toBe(entry.key);
  expect(remove.disabled).toBe(false);
});
