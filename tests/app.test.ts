import { afterEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";

const { start, register } = vi.hoisted(() => ({
  start: vi.fn(),
  register: vi.fn(),
}));
vi.mock("../src/import-screen", () => ({ startImportScreen: start }));
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
  await import("../src/main");
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({ file: document.querySelector("input") }),
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
  await import("../src/main");
  expect(start).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
});

it("fails explicitly when the built page is missing required controls", async () => {
  document.body.replaceChildren();
  await expect(import("../src/main")).rejects.toThrow("Élément absent");
});
