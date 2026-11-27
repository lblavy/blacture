interface InstallControls {
  installButton: HTMLButtonElement;
  installStatus: HTMLElement;
  persistButton: HTMLButtonElement;
  persistStatus: HTMLElement;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function connectInstallPrompt(
  installButton: HTMLButtonElement,
  status: HTMLElement,
  signal: AbortSignal,
) {
  const displayMode = window.matchMedia?.("(display-mode: standalone)");
  let offered: InstallPromptEvent | undefined;
  let prompting = false;
  let accepted = false;

  function updateButton() {
    installButton.hidden =
      !offered || prompting || accepted || displayMode?.matches === true;
  }

  function markAccepted() {
    accepted = true;
    offered = undefined;
    status.textContent = "Installation acceptée par le navigateur.";
    updateButton();
  }

  async function promptInstall() {
    if (!offered || installButton.hidden) return;
    const invitation = offered;
    offered = undefined;
    prompting = true;
    updateButton();
    try {
      await invitation.prompt();
      const { outcome } = await invitation.userChoice;
      if (signal.aborted || accepted) return;
      if (outcome === "accepted") markAccepted();
      else status.textContent = "Installation annulée.";
    } catch {
      if (!signal.aborted && !accepted)
        status.textContent = "La demande d’installation a échoué.";
    } finally {
      prompting = false;
      if (!signal.aborted) updateButton();
    }
  }

  window.addEventListener(
    "beforeinstallprompt",
    (event) => {
      if (accepted || displayMode?.matches) return;
      event.preventDefault();
      offered = event as InstallPromptEvent;
      updateButton();
    },
    { signal },
  );
  window.addEventListener("appinstalled", markAccepted, { signal });
  displayMode?.addEventListener("change", updateButton, { signal });
  installButton.addEventListener("click", () => void promptInstall(), {
    signal,
  });
  updateButton();
}

function storageMessage(persisted: boolean, granted: boolean | undefined) {
  if (persisted) return "Stockage persistant activé.";
  if (granted === undefined) return "Stockage persistant non activé.";
  return granted
    ? "Stockage persistant non confirmé par le navigateur."
    : "Le navigateur n’a pas accordé le stockage persistant.";
}

function connectPersistence(
  persistButton: HTMLButtonElement,
  status: HTMLElement,
  signal: AbortSignal,
) {
  const storage = navigator.storage;
  persistButton.disabled = true;
  persistButton.hidden = true;
  if (
    typeof storage?.persist !== "function" ||
    typeof storage.persisted !== "function"
  ) {
    status.textContent = "Ce navigateur ne propose pas le stockage persistant.";
    return;
  }
  persistButton.hidden = false;

  async function refresh(request: boolean) {
    persistButton.disabled = true;
    try {
      const granted = request ? await storage.persist() : undefined;
      const persisted = await storage.persisted();
      if (signal.aborted) return;
      status.textContent = storageMessage(persisted, granted);
      persistButton.disabled = persisted;
    } catch {
      if (signal.aborted) return;
      status.textContent = request
        ? "Demande de stockage persistant impossible."
        : "Vérification du stockage persistant impossible.";
      persistButton.disabled = false;
    }
  }

  persistButton.addEventListener(
    "click",
    () => {
      if (!persistButton.disabled) void refresh(true);
    },
    { signal },
  );
  void refresh(false);
}

export function startInstallSupport({
  installButton,
  installStatus,
  persistButton,
  persistStatus,
}: InstallControls): () => void {
  const listeners = new AbortController();
  connectInstallPrompt(installButton, installStatus, listeners.signal);
  connectPersistence(persistButton, persistStatus, listeners.signal);
  return () => listeners.abort();
}
