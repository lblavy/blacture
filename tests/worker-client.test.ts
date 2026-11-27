import { expect, it, vi } from "vitest";
import { registerOfflineWorker } from "../src/worker-client";

function setup() {
  const worker = Object.assign(new EventTarget(), {
    state: "installing",
    postMessage: vi.fn(),
  });
  const active = Object.assign(new EventTarget(), {
    state: "activated",
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
    active,
    registration,
    container,
    status: document.createElement("p"),
    button: document.createElement("button"),
    reload: vi.fn(),
    prepare: vi
      .fn<() => Promise<void | (() => void)>>()
      .mockResolvedValue(undefined),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("attend un contrôleur avant d’annoncer le mode hors ligne", async () => {
  const { worker, container, status, button, reload, prepare } = setup();
  await registerOfflineWorker(
    status,
    button,
    prepare,
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
  expect(prepare).not.toHaveBeenCalled();
});

it("reconnaît un premier contrôleur même avant la résolution de l’enregistrement", async () => {
  const { worker, registration, container, status, button, reload, prepare } =
    setup();
  const wait = deferred();
  container.register.mockReturnValueOnce(wait.promise.then(() => registration));
  const started = registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  container.controller = worker;
  container.dispatchEvent(new Event("controllerchange"));
  expect(status.textContent).toBe("Disponible hors ligne");
  wait.resolve();
  await started;
  expect(prepare).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("attend les écritures avant l’activation explicite et de nouveau avant le rechargement", async () => {
  const {
    worker,
    active,
    registration,
    container,
    status,
    button,
    reload,
    prepare,
  } = setup();
  const beforeActivation = deferred();
  const beforeReload = deferred();
  prepare
    .mockReturnValueOnce(beforeActivation.promise)
    .mockReturnValueOnce(beforeReload.promise);
  container.controller = active;
  await registerOfflineWorker(
    status,
    button,
    prepare,
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
  button.dispatchEvent(new Event("click"));
  expect(prepare).toHaveBeenCalledOnce();
  expect(worker.postMessage).not.toHaveBeenCalled();
  beforeActivation.resolve();
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith("apply-update"),
  );
  container.controller = worker;
  registration.waiting = null;
  container.dispatchEvent(new Event("controllerchange"));
  container.dispatchEvent(new Event("controllerchange"));
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(reload).not.toHaveBeenCalled();
  beforeReload.resolve();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
});

it("laisse réessayer une prise de contrôle venue d’un autre onglet si les écritures échouent", async () => {
  const { worker, active, container, status, button, reload, prepare } =
    setup();
  prepare.mockRejectedValueOnce(new Error("écriture locale"));
  container.controller = active;
  await registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  container.controller = worker;
  container.dispatchEvent(new Event("controllerchange"));
  await vi.waitFor(() => expect(status.textContent).toContain("Impossible"));
  expect(reload).not.toHaveBeenCalled();
  expect(button.hidden).toBe(false);
  expect(button.disabled).toBe(false);
  button.click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("laisse réessayer l’activation quand la préparation des écritures a échoué", async () => {
  const {
    worker,
    active,
    registration,
    container,
    status,
    button,
    reload,
    prepare,
  } = setup();
  prepare.mockRejectedValueOnce(new Error("écriture locale"));
  container.controller = active;
  registration.waiting = worker;
  await registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  button.click();
  await vi.waitFor(() => expect(status.textContent).toContain("Impossible"));
  expect(worker.postMessage).not.toHaveBeenCalled();
  button.click();
  await vi.waitFor(() =>
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith("apply-update"),
  );
});

it("évite un envoi obsolète si un autre onglet active la version pendant la préparation", async () => {
  const {
    worker,
    active,
    registration,
    container,
    status,
    button,
    reload,
    prepare,
  } = setup();
  const delay = deferred();
  prepare.mockReturnValueOnce(delay.promise);
  container.controller = active;
  registration.waiting = worker;
  await registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  button.click();
  registration.waiting = null;
  container.controller = worker;
  container.dispatchEvent(new Event("controllerchange"));
  expect(reload).not.toHaveBeenCalled();
  delay.resolve();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(worker.postMessage).not.toHaveBeenCalled();
});

it("attend un clic de reprise si la préparation échoue pendant l’activation par un autre onglet", async () => {
  const {
    worker,
    active,
    registration,
    container,
    status,
    button,
    reload,
    prepare,
  } = setup();
  const delay = deferred();
  prepare.mockReturnValueOnce(
    delay.promise.then(() => {
      throw new Error("Enregistrement local échoué");
    }),
  );
  container.controller = active;
  registration.waiting = worker;
  await registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  button.click();
  registration.waiting = null;
  container.controller = worker;
  container.dispatchEvent(new Event("controllerchange"));
  delay.resolve();
  await vi.waitFor(() => expect(status.textContent).toContain("Impossible"));
  expect(button.hidden).toBe(false);
  expect(button.disabled).toBe(false);
  expect(prepare).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();

  button.click();
  await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(worker.postMessage).not.toHaveBeenCalled();
});

it("libère les actions locales si la version en attente a disparu sans prendre le contrôle", async () => {
  const {
    worker,
    active,
    registration,
    container,
    status,
    button,
    reload,
    prepare,
  } = setup();
  const delay = deferred();
  const release = vi.fn();
  prepare.mockReturnValueOnce(delay.promise.then(() => release));
  container.controller = active;
  registration.waiting = worker;
  await registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  button.click();
  registration.waiting = null;
  delay.resolve();
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  expect(button.hidden).toBe(true);
  expect(status.textContent).toContain("plus disponible");
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("libère les actions locales si l’envoi ou l’activation échoue", async () => {
  const {
    worker,
    active,
    registration,
    container,
    status,
    button,
    reload,
    prepare,
  } = setup();
  const release = vi.fn();
  prepare.mockResolvedValue(release);
  worker.postMessage.mockImplementationOnce(() => {
    throw new Error("worker parti");
  });
  container.controller = active;
  registration.waiting = worker;
  await registerOfflineWorker(
    status,
    button,
    prepare,
    container as unknown as ServiceWorkerContainer,
    reload,
  );
  button.click();
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  button.click();
  await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
  worker.state = "redundant";
  registration.waiting = null;
  worker.dispatchEvent(new Event("statechange"));
  expect(release).toHaveBeenCalledTimes(2);
  expect(status.textContent).toContain("Impossible");
  expect(reload).not.toHaveBeenCalled();
});

it("signale un refus d’enregistrer le service worker", async () => {
  const { container, status, button } = setup();
  container.register.mockRejectedValueOnce(new Error("No worker"));
  await registerOfflineWorker(
    status,
    button,
    undefined,
    container as unknown as ServiceWorkerContainer,
  );
  expect(status.textContent).toContain("Impossible");
});

it("signale un navigateur sans service worker", async () => {
  const { status, button } = setup();
  await registerOfflineWorker(status, button);
  expect(status.textContent).toContain("indisponible");
});
