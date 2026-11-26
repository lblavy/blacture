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
    preview: document.querySelector<HTMLElement>("#fragment-preview")!,
  };
  Object.defineProperty(controls.file, "files", {
    get: () => ({ item: () => new File(["# Article"], "article.md") }),
  });
  const preview = {
    open: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
  };
  const services = {
    runImport: vi
      .fn()
      .mockResolvedValue({ diagnostics: [] } as unknown as ImportedBook),
    saveEdition: vi.fn().mockResolvedValue(entry),
    listBooks: vi.fn().mockResolvedValue([entry]),
    createFragmentPreview: () => preview,
  };
  const submit = () =>
    controls.form.dispatchEvent(new Event("submit", { cancelable: true }));
  return { controls, services, submit, preview };
}

it("renders the catalogue and refreshes it only upon a successful commit", async () => {
  const { controls, services, submit, preview } = fixture();
  services.listBooks.mockResolvedValueOnce([]);
  services.runImport.mockImplementation((_source, _signal, onProgress) => {
    onProgress("parse");
    return Promise.resolve({ diagnostics: [] } as unknown as ImportedBook);
  });
  startImportScreen(controls, services);
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
  expect(preview.open).toHaveBeenCalledWith(entry);
});

it("shows data loss diagnostics without publishing the edition", async () => {
  const { controls, services, submit } = fixture();
  services.runImport.mockResolvedValue({
    diagnostics: [
      { code: "duplicate-anchor", severity: "error", count: 1 },
      { code: "test-warning", severity: "warning", count: 2 },
    ],
  });
  startImportScreen(controls, services);
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
  const { controls, services, submit } = fixture();
  services.runImport.mockImplementation(
    (_source, signal: AbortSignal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
  startImportScreen(controls, services);
  submit();
  controls.cancel.click();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toBe("Import annulé."),
  );
  expect(controls.catalog.textContent).toBe(entry.title);
  expect(controls.cancel.hidden).toBe(true);
});

it("reports errors opening the catalogue and starting an import", async () => {
  const { controls, services, submit } = fixture();
  services.listBooks.mockRejectedValueOnce(new Error("Stockage indisponible"));
  services.runImport.mockRejectedValueOnce(new Error("Fichier inaccessible"));
  startImportScreen(controls, services);
  await vi.waitFor(() =>
    expect(controls.status.textContent).toMatch(/catalogue local/),
  );
  submit();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toBe("Fichier inaccessible"),
  );
});

it("reports a rejected preview", async () => {
  const { controls, services, preview } = fixture();
  preview.open.mockRejectedValueOnce(new Error("Fragment manquant"));
  startImportScreen(controls, services);
  await vi.waitFor(() =>
    expect(controls.catalog.querySelector("button")).toBeTruthy(),
  );
  controls.catalog.querySelector("button")?.click();
  await vi.waitFor(() =>
    expect(controls.status.textContent).toMatch(/lire le premier fragment/),
  );
});
