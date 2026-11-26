export async function registerOfflineWorker(
  status: HTMLElement,
  update: HTMLButtonElement,
  container = navigator.serviceWorker,
  reload = () => window.location.reload(),
) {
  if (!container) {
    status.textContent = "Hors ligne indisponible dans ce navigateur.";
    return;
  }

  let controlled = Boolean(container.controller);
  try {
    const registration = await container.register(
      new URL("service-worker.js", document.baseURI),
      { updateViaCache: "none" },
    );
    const showWaiting = () => {
      update.hidden = !registration.waiting || !container.controller;
    };
    const watchInstall = () => {
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "redundant" && !container.controller) {
          status.textContent = "Impossible de préparer le mode hors ligne.";
        }
        showWaiting();
      });
    };
    status.textContent = controlled
      ? "Disponible hors ligne"
      : "Préparation du mode hors ligne…";
    update.addEventListener("click", () =>
      registration.waiting?.postMessage("apply-update"),
    );
    registration.addEventListener("updatefound", watchInstall);
    container.addEventListener("controllerchange", () => {
      if (controlled) {
        reload();
        return;
      }
      controlled = true;
      status.textContent = "Disponible hors ligne";
    });
    watchInstall();
    showWaiting();
  } catch {
    status.textContent = "Impossible de préparer le mode hors ligne.";
  }
}
