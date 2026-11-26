import { afterEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";

const { start, startReader, openBook, resumeBook, refreshCatalog, register } =
  vi.hoisted(() => ({
    start: vi.fn(),
    startReader: vi.fn(),
    openBook: vi.fn(),
    resumeBook: vi.fn(),
    refreshCatalog: vi.fn(),
    register: vi.fn(),
  }));
vi.mock("../src/import-screen", () => ({ startImportScreen: start }));
vi.mock("../src/reader", () => ({ startReader }));
vi.mock("../src/worker-client", () => ({ registerOfflineWorker: register }));

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
  );
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
