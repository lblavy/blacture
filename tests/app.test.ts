import { afterEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";

const {
  start,
  startReader,
  openBook,
  resumeBook,
  refreshCatalog,
  register,
  install,
} = vi.hoisted(() => ({
  start: vi.fn(),
  startReader: vi.fn(),
  openBook: vi.fn(),
  resumeBook: vi.fn(),
  refreshCatalog: vi.fn(),
  register: vi.fn(),
  install: vi.fn(),
}));
vi.mock("../src/import-screen", () => ({ startImportScreen: start }));
vi.mock("../src/reader", () => ({ startReader }));
vi.mock("../src/worker-client", () => ({ registerOfflineWorker: register }));
vi.mock("../src/install-support", () => ({ startInstallSupport: install }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

it("mounts the import screen and registers offline support in production", async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  vi.stubEnv("PROD", true);
  start.mockReturnValue({ refresh: refreshCatalog });
  startReader.mockReturnValue({ open: openBook, resume: resumeBook });
  await import("../src/main");
  expect(startReader).toHaveBeenCalledWith(
    expect.objectContaining({
      panel: document.querySelector("#reader"),
      contents: document.querySelector("#fragment-preview"),
      outline: document.querySelector("#reader-toc"),
    }),
    refreshCatalog,
  );
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ file: document.querySelector("input") }),
    expect.objectContaining({
      open: expect.any(Function),
      resume: expect.any(Function),
    }),
  );
  expect(register).toHaveBeenCalledWith(
    document.querySelector("#offline-status"),
    document.querySelector("#update"),
    expect.any(Function),
    undefined,
    expect.any(Function),
  );
  expect(install).toHaveBeenCalledWith(
    expect.objectContaining({
      installButton: document.querySelector("#install-app"),
      persistButton: document.querySelector("#request-persistence"),
    }),
  );
});

it("shares update preparation and restores the app when activation is cancelled", async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  vi.stubEnv("PROD", true);
  const restoreReader = vi.fn();
  const restoreCatalog = vi.fn();
  const prepareReader = vi.fn().mockResolvedValue(restoreReader);
  const prepareCatalog = vi.fn().mockResolvedValue(undefined);
  start.mockReturnValue({
    refresh: refreshCatalog,
    prepareUpdate: prepareCatalog,
    resumeAfterUpdate: restoreCatalog,
  });
  startReader.mockReturnValue({ prepareUpdate: prepareReader });
  await import("../src/main");
  const prepare = register.mock.calls[0]?.[2] as () => Promise<() => void>;
  const first = prepare();
  expect(prepare()).toBe(first);
  const release = await first;
  expect(prepareReader).toHaveBeenCalledOnce();
  expect(prepareCatalog).toHaveBeenCalledOnce();
  release();
  expect(restoreReader).toHaveBeenCalledOnce();
  expect(restoreCatalog).toHaveBeenCalledOnce();
  expect(prepare()).not.toBe(first);
});

it("releases a prepared reader and allows a new attempt after an import error", async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  vi.stubEnv("PROD", true);
  const restoreReader = vi.fn();
  const restoreCatalog = vi.fn();
  start.mockReturnValue({
    refresh: refreshCatalog,
    prepareUpdate: vi
      .fn()
      .mockRejectedValueOnce(new Error("Import interrompu"))
      .mockResolvedValue(undefined),
    resumeAfterUpdate: restoreCatalog,
  });
  startReader.mockReturnValue({
    prepareUpdate: vi.fn().mockResolvedValue(restoreReader),
  });
  await import("../src/main");
  const prepare = register.mock.calls[0]?.[2] as () => Promise<() => void>;
  await expect(prepare()).rejects.toThrow("Import interrompu");
  expect(restoreReader).toHaveBeenCalledOnce();
  expect(restoreCatalog).toHaveBeenCalledOnce();
  expect(await prepare()).toEqual(expect.any(Function));
});

it("mounts without installing a service worker in development", async () => {
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  start.mockReturnValue({ refresh: refreshCatalog });
  startReader.mockReturnValue({ open: openBook, resume: resumeBook });
  await import("../src/main");
  expect(start).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
});

it("fails explicitly when the built page is missing required controls", async () => {
  document.body.replaceChildren();
  await expect(import("../src/main")).rejects.toThrow("Élément absent");
});
