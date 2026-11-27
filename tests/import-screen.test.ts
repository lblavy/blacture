import { expect, it, vi } from "vitest";
import { startImportScreen } from "../src/import-screen";
import type { ImportedBook } from "../src/import";
import page from "../index.html?raw";

const entry = {
  key: "1",
  title: "Livre importé",
  firstFragmentId: "first",
  resourceBytes: 0,
};

function fixture() {
  document.body.innerHTML = new DOMParser().parseFromString(
    page,
    "text/html",
  ).body.innerHTML;
  const controls = {
    form: document.querySelector<HTMLFormElement>("form")!,
    file: document.querySelector<HTMLInputElement>("input")!,
    submit: document.querySelector<HTMLButtonElement>("#import-submit")!,
    cancel: document.querySelector<HTMLButtonElement>("#import-cancel")!,
    status: document.querySelector<HTMLElement>("#import-status")!,
    diagnostics: document.querySelector<HTMLElement>("#import-diagnostics")!,
    catalog: document.querySelector<HTMLElement>("#catalog")!,
    empty: document.querySelector<HTMLElement>("#catalog-empty")!,
  };
  Object.defineProperty(controls.file, "files", {
    get: () => ({ item: () => new File(["# Article"], "article.md") }),
  });
  const actions = {
    open: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
  };
  const services = {
    runImport: vi
      .fn()
      .mockResolvedValue({ diagnostics: [] } as unknown as ImportedBook),
    saveEdition: vi.fn().mockResolvedValue(entry),
    replaceEdition: vi
      .fn()
      .mockResolvedValue({ key: "2", omitted: 1, replaced: true }),
    listBooks: vi.fn().mockResolvedValue([entry]),
  };
  const submit = () =>
    controls.form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { controls, services, submit, actions };
}

it("replaces only the chosen book and reports omitted reading progress", async () => {
  const { controls, services, submit, actions } = fixture();
  startImportScreen(controls, actions, services);
  const replacement = controls.form.querySelector<HTMLSelectElement>(
    "#import-replacement",
  )!;
  await vi.waitFor(() => expect(replacement.options).toHaveLength(2));
  replacement.value = entry.key;
  replacement.dispatchEvent(new Event("change"));
  expect(controls.submit.textContent).toBe("Remplacer l’ouvrage");
  submit();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toContain("1 élément du suivi"),
  );
  expect(services.replaceEdition).toHaveBeenCalledWith(
    entry.key,
    expect.anything(),
    expect.any(AbortSignal),
  );
  expect(services.saveEdition).not.toHaveBeenCalled();
  expect(replacement.value).toBe("");
});

it("renders the catalogue and refreshes it only upon a successful commit", async () => {
  const { controls, services, submit, actions } = fixture();
  services.listBooks.mockResolvedValueOnce([]);
  services.runImport.mockImplementation((_source, _signal, onProgress) => {
    onProgress("parse");
    return Promise.resolve({ diagnostics: [] } as unknown as ImportedBook);
  });
  startImportScreen(controls, actions, services);
  submit();
  expect(controls.submit.disabled).toBe(true);
  expect(controls.status.textContent).toMatch(/Analyse/);
  submit();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toBe("Import terminé."),
  );
  expect(services.saveEdition).toHaveBeenCalledOnce();
  const button = controls.catalog.querySelector("button");
  expect(button?.textContent).toBe(entry.title);
  button?.click();
  expect(actions.open).toHaveBeenCalledWith(entry);
  expect(controls.empty.hidden).toBe(true);
});

it("shows data loss diagnostics without publishing the edition", async () => {
  const { controls, services, submit, actions } = fixture();
  services.runImport.mockResolvedValue({
    diagnostics: [
      { code: "duplicate-anchor", severity: "error", count: 1 },
      { code: "test-warning", severity: "warning", count: 2 },
    ],
  });
  startImportScreen(controls, actions, services);
  submit();
  await vi.waitFor(() => expect(controls.submit.disabled).toBe(false));
  expect(controls.diagnostics.hidden).toBe(false);
  expect(controls.diagnostics.textContent).toContain(
    "Identifiant d’ancre en double",
  );
  expect(controls.diagnostics.textContent).toContain(
    "Avertissement · test-warning (2)",
  );
  expect(services.saveEdition).not.toHaveBeenCalled();
});

it("cancels a busy import and leaves the saved catalogue intact", async () => {
  const { controls, services, submit, actions } = fixture();
  services.runImport.mockImplementation(
    (_source, signal: AbortSignal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  startImportScreen(controls, actions, services);
  submit();
  controls.cancel.click();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toBe("Import annulé."),
  );
  expect(controls.catalog.textContent).toContain(entry.title);
  expect(controls.cancel.hidden).toBe(true);
});

it("lets the current import finish before an update and blocks new imports", async () => {
  const { controls, services, submit, actions } = fixture();
  let finishSave!: (result: typeof entry) => void;
  services.saveEdition.mockReturnValueOnce(
    new Promise<typeof entry>((resolve) => {
      finishSave = resolve;
    }),
  );
  const screen = startImportScreen(controls, actions, services);
  submit();
  await vi.waitFor(() => expect(services.saveEdition).toHaveBeenCalledOnce());
  const prepared = vi.fn();
  const preparation = screen.prepareUpdate().then(prepared);
  await Promise.resolve();
  expect(prepared).not.toHaveBeenCalled();
  expect(controls.cancel.hidden).toBe(false);
  finishSave(entry);
  await preparation;
  expect(controls.status.textContent).toBe("Import terminé.");
  expect(controls.file.disabled).toBe(true);
  expect(controls.catalog.inert).toBe(true);
  submit();
  expect(services.runImport).toHaveBeenCalledOnce();
  screen.resumeAfterUpdate();
  expect(controls.file.disabled).toBe(false);
  expect(controls.catalog.inert).toBe(false);
});

it("keeps the current import error visible if its write fails during an update", async () => {
  const { controls, services, submit, actions } = fixture();
  services.saveEdition.mockRejectedValueOnce(
    new DOMException("Disque plein", "QuotaExceededError"),
  );
  const screen = startImportScreen(controls, actions, services);
  submit();
  await expect(screen.prepareUpdate()).rejects.toThrow(/import/i);
  expect(controls.status.textContent).toMatch(/Espace de stockage insuffisant/);
  screen.resumeAfterUpdate();
  expect(controls.file.disabled).toBe(false);
  expect(await screen.prepareUpdate()).toBeUndefined();
});

it("reports errors opening the catalogue and starting an import", async () => {
  const { controls, services, submit, actions } = fixture();
  services.listBooks.mockRejectedValueOnce(new Error("Stockage indisponible"));
  services.runImport.mockRejectedValueOnce(new Error("Fichier inaccessible"));
  startImportScreen(controls, actions, services);
  await vi.waitFor(() =>
    expect(controls.status.textContent).toMatch(/catalogue local/),
  );
  submit();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toBe("Fichier inaccessible"),
  );
});

it("reports failure opening a local work", async () => {
  const { controls, services, actions } = fixture();
  actions.open.mockRejectedValueOnce(new Error("Fragment manquant"));
  startImportScreen(controls, actions, services);
  await vi.waitFor(() =>
    expect(controls.catalog.querySelector("button")).toBeTruthy(),
  );
  controls.catalog.querySelector("button")?.click();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toMatch(/ouvrir cet ouvrage/),
  );
});

it("shows an empty catalogue after checking local storage", async () => {
  const { controls, services, actions } = fixture();
  services.listBooks.mockResolvedValue([]);
  startImportScreen(controls, actions, services);
  await vi.waitFor(() => expect(controls.empty.hidden).toBe(false));
  expect(controls.catalog.children).toHaveLength(0);
});

it("keeps the last consultation available when all reading is complete", async () => {
  const { controls, services, actions } = fixture();
  services.listBooks.mockResolvedValue([
    { ...entry, progress: { status: "complete", percent: 100, hasLast: true } },
  ]);
  startImportScreen(controls, actions, services);
  await vi.waitFor(() =>
    expect(controls.catalog.textContent).toContain("Terminé"),
  );
  const options = Array.from(controls.catalog.querySelectorAll("button"));
  expect(options.map((button) => button.textContent)).toEqual([
    entry.title,
    "Dernière consultation",
  ]);
  options.at(-1)?.click();
  expect(actions.resume).toHaveBeenCalledWith(
    expect.objectContaining({ key: entry.key }),
    "last",
  );
});
