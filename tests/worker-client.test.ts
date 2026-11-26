import { expect, it, vi } from "vitest";
import { registerOfflineWorker } from "../src/worker-client";

function setup() {
  const worker = Object.assign(new EventTarget(), {
    state: "installing",
    postMessage: vi.fn(),
  });
  const registration = Object.assign(new EventTarget(), {
    waiting: null as typeof worker | null,
    installing: worker,
  });
  const container = Object.assign(new EventTarget(), {
    controller: null as typeof worker | null,
    register: vi.fn().mockResolvedValue(registration),
  });
  return {
    worker,
    registration,
    container,
    status: document.createElement("p"),
    button: document.createElement("button"),
    reload: vi.fn(),
  };
}

it("attend un contrôleur avant d’annoncer le mode hors ligne", async () => {
  const { worker, container, status, button, reload } = setup();
  await registerOfflineWorker(
    status,
    button,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  expect(status.textContent).toContain("Préparation");
  expect(button.hidden).toBe(true);

  worker.state = "redundant";
  worker.dispatchEvent(new Event("statechange"));
  expect(status.textContent).toContain("Impossible");

  container.controller = worker;
  container.dispatchEvent(new Event("controllerchange"));
  expect(status.textContent).toBe("Disponible hors ligne");
  expect(reload).not.toHaveBeenCalled();
});

it("rend la mise à jour explicite et recharge après prise de contrôle", async () => {
  const { worker, registration, container, status, button, reload } = setup();
  container.controller = worker;
  await registerOfflineWorker(
    status,
    button,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  expect(status.textContent).toBe("Disponible hors ligne");
  expect(button.hidden).toBe(true);
  registration.waiting = worker;
  worker.state = "installed";
  worker.dispatchEvent(new Event("statechange"));
  expect(button.hidden).toBe(false);
  expect(worker.postMessage).not.toHaveBeenCalled();
  button.click();
  expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith("apply-update");
  container.dispatchEvent(new Event("controllerchange"));
  expect(reload).toHaveBeenCalledOnce();
});

it("signale un refus d’enregistrer le service worker", async () => {
  const { container, status, button } = setup();
  container.register.mockRejectedValueOnce(new Error("No worker"));
  await registerOfflineWorker(
    status,
    button,
    container as unknown as ServiceWorkerContainer,
  );
  expect(status.textContent).toContain("Impossible");
});

it("signale un navigateur sans service worker", async () => {
  const { status, button } = setup();
  await registerOfflineWorker(status, button);
  expect(status.textContent).toContain("indisponible");
});
