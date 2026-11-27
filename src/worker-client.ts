const unavailable = "Impossible de préparer le mode hors ligne.";
const ready = "Disponible hors ligne";
const updateFailed = "Impossible de terminer la mise à jour. Réessaie.";

type PrepareUpdate = () => Promise<void | (() => void)>;

export async function registerOfflineWorker(
  status: HTMLElement,
  update: HTMLButtonElement,
  prepareUpdate: PrepareUpdate = async () => undefined,
  container = navigator.serviceWorker,
  reload = () => window.location.reload(),
) {
  if (!container) {
    status.textContent = "Hors ligne indisponible dans ce navigateur.";
    return;
  }

  let controller = container.controller;
  let registration: ServiceWorkerRegistration | undefined;
  let applying: ServiceWorker | undefined;
  let release: (() => void) | undefined;
  let busy = false;
  let reloadPending = false;
  let reloaded = false;

  function waitingWorker() {
    const waiting = registration?.waiting;
    return controller && waiting && waiting.state !== "redundant"
      ? waiting
      : undefined;
  }

  function showUpdate() {
    update.hidden = !reloadPending && !waitingWorker();
    update.disabled = busy || !!applying || reloaded;
  }

  function fail(message: string) {
    applying = undefined;
    const unblock = release;
    release = undefined;
    unblock?.();
    status.textContent = message;
    showUpdate();
  }

  function apply(waiting: ServiceWorker) {
    if (waiting !== waitingWorker()) {
      fail("La mise à jour n’est plus disponible.");
      return;
    }
    applying = waiting;
    waiting.postMessage("apply-update");
    function watchActivation() {
      if (waiting.state !== "redundant") return;
      waiting.removeEventListener("statechange", watchActivation);
      if (applying === waiting) fail(updateFailed);
    }
    waiting.addEventListener("statechange", watchActivation);
    status.textContent = "Activation de la mise à jour…";
  }

  function prepare() {
    if (busy || applying || reloaded) return;
    const replacing = reloadPending;
    const waiting = waitingWorker();
    if (!replacing && !waiting) return;
    void finishPreparation(replacing, waiting);
  }

  async function finishPreparation(
    replacing: boolean,
    waiting: ServiceWorker | undefined,
  ) {
    busy = true;
    status.textContent = "Préparation de la mise à jour…";
    showUpdate();
    try {
      release = (await prepareUpdate()) ?? release;
      if (replacing) {
        reload();
        reloaded = true;
      } else if (!reloadPending && waiting) apply(waiting);
    } catch {
      fail(updateFailed);
      return;
    } finally {
      busy = false;
      showUpdate();
    }
    if (!replacing && reloadPending) prepare();
  }

  function controllerChanged() {
    const next = container.controller;
    if (!next || next === controller) return;
    const wasControlled = Boolean(controller);
    controller = next;
    applying = undefined;
    if (wasControlled) {
      reloadPending = true;
      prepare();
    } else {
      status.textContent = ready;
    }
    showUpdate();
  }

  function watchInstall() {
    const installing = registration?.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "redundant" && !controller)
        status.textContent = unavailable;
      showUpdate();
    });
  }

  status.textContent = controller ? ready : "Préparation du mode hors ligne…";
  update.addEventListener("click", prepare);
  container.addEventListener("controllerchange", controllerChanged);
  try {
    registration = await container.register(
      new URL("service-worker.js", document.baseURI),
      { updateViaCache: "none" },
    );
    registration.addEventListener("updatefound", watchInstall);
    watchInstall();
    showUpdate();
  } catch {
    status.textContent = unavailable;
  }
}
