export interface DrivePanelBook {
  key: string;
  title: string;
}

export interface DrivePanelResult {
  state: "connected" | "disconnected" | "reconnect";
  message?: string;
  books?: readonly DrivePanelBook[];
}

export interface DrivePanelActions {
  prepare(): Promise<boolean>;
  authorize(signal: AbortSignal): Promise<DrivePanelResult>;
  disconnect(): void;
  localBooks(): Promise<readonly DrivePanelBook[]>;
  refresh(signal: AbortSignal): Promise<DrivePanelResult>;
  synchronize(key: string, signal: AbortSignal): Promise<DrivePanelResult>;
  download(key: string, signal: AbortSignal): Promise<DrivePanelResult>;
}

const messages: Record<DrivePanelResult["state"], string> = {
  connected: "Connecté à Google Drive.",
  disconnected: "Google Drive déconnecté.",
  reconnect: "Reprenez la connexion à Google Drive.",
};

type Operation = (signal: AbortSignal) => Promise<DrivePanelResult>;

export function mountDrivePanel(
  panel: HTMLDetailsElement,
  actions: DrivePanelActions,
) {
  const listeners = new AbortController();
  const { signal } = listeners;

  function element<T extends HTMLElement>(id: string): T {
    const element = panel.querySelector<T>(`#drive-${id}`);
    if (!element) throw new Error(`Élément Drive absent : ${id}`);
    return element;
  }

  const button = (id: string) => element<HTMLButtonElement>(id);
  const load = button("load");
  const connect = button("connect");
  const disconnect = button("disconnect");
  const cancelButton = button("cancel");
  const synchronize = button("sync");
  const refresh = button("refresh");
  const status = element("status");
  const library = element("library");
  const localError = element("local-error");
  const localBook = element<HTMLSelectElement>("local-book");
  const remoteBooks = element<HTMLUListElement>("remote-books");
  const noRemoteBooks = element("remote-empty");
  let state: DrivePanelResult["state"] = "disconnected";
  let ready = false;
  let preparing = false;
  let opened = false;
  let localRevision = 0;
  let operation: AbortController | undefined;
  let pending = Promise.resolve();

  function renderControls() {
    const connected = state === "connected";
    const busy = operation !== undefined;
    load.hidden = ready || preparing || connected;
    connect.hidden = connected;
    connect.disabled = !ready || busy;
    connect.textContent =
      state === "reconnect"
        ? "Reprendre la connexion Google Drive"
        : "Connecter Google Drive";
    disconnect.hidden = state === "disconnected";
    disconnect.disabled = busy;
    cancelButton.hidden = !busy;
    cancelButton.disabled = operation?.signal.aborted === true;
    library.hidden = !connected;
    localBook.disabled = busy;
    synchronize.disabled = busy || !localBook.value;
    refresh.disabled = busy;
    for (const download of remoteBooks.querySelectorAll("button"))
      download.disabled = busy;
  }

  async function prepare() {
    if (ready || preparing || state === "connected") return;
    preparing = true;
    status.textContent = "Chargement de la connexion Google…";
    renderControls();
    try {
      ready = await actions.prepare();
    } catch {
      ready = false;
    } finally {
      preparing = false;
    }
    if (signal.aborted) return;
    status.textContent = ready
      ? messages[state]
      : "Connexion Google indisponible. Vous pouvez réessayer.";
    renderControls();
  }

  async function refreshLocal() {
    if (signal.aborted) return;
    const revision = ++localRevision;
    try {
      const books = await actions.localBooks();
      if (signal.aborted || revision !== localRevision) return;
      const previous = localBook.value;
      const options = books.map(({ key, title }) => new Option(title, key));
      localBook.replaceChildren(
        new Option("Choisir un ouvrage", ""),
        ...options,
      );
      if (options.some(({ value }) => value === previous))
        localBook.value = previous;
      localError.textContent = "";
      renderControls();
    } catch {
      if (!signal.aborted && revision === localRevision)
        localError.textContent = "Impossible de lire la bibliothèque locale.";
    }
  }

  function showRemoteBooks(books: readonly DrivePanelBook[]) {
    const entries = books.map(({ key, title }) => {
      const item = document.createElement("li");
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = "Télécharger";
      download.setAttribute("aria-label", `Télécharger ${title}`);
      download.addEventListener(
        "click",
        () => {
          if (state !== "connected" || !remoteBooks.contains(item)) return;
          start("Téléchargement de l’ouvrage…", async (signal) => {
            const result = await actions.download(key, signal);
            if (!signal.aborted && result.state === "connected")
              void refreshLocal();
            return result;
          });
        },
        { signal },
      );
      item.append(`${title} `, download);
      return item;
    });
    remoteBooks.replaceChildren(...entries);
    noRemoteBooks.hidden = entries.length !== 0;
  }

  function showResult(result: DrivePanelResult) {
    state = result.state;
    status.textContent = result.message ?? messages[state];
    if (state !== "connected") {
      localBook.value = "";
      remoteBooks.replaceChildren();
      noRemoteBooks.hidden = true;
    } else if (result.books) {
      showRemoteBooks(result.books);
    }
  }

  async function run(controller: AbortController, action: Operation) {
    try {
      const result = await action(controller.signal);
      if (!controller.signal.aborted) showResult(result);
    } catch {
      if (!controller.signal.aborted)
        status.textContent =
          "Opération Google Drive impossible. Vous pouvez réessayer.";
    } finally {
      operation = undefined;
      if (!signal.aborted) {
        if (controller.signal.aborted)
          status.textContent = "Opération annulée.";
        renderControls();
      }
    }
  }

  function start(message: string, action: Operation) {
    if (operation || signal.aborted) return;
    const controller = new AbortController();
    operation = controller;
    status.textContent = message;
    renderControls();
    // run calls the injected action before awaiting the resulting promise.
    pending = run(controller, action);
  }

  function cancel() {
    if (!operation || operation.signal.aborted) return;
    operation.abort();
    status.textContent = "Annulation en cours…";
    renderControls();
  }

  panel.addEventListener(
    "toggle",
    () => {
      if (panel.open === opened) return;
      opened = panel.open;
      if (opened) {
        void prepare();
        void refreshLocal();
      }
    },
    { signal },
  );
  load.addEventListener("click", () => void prepare(), { signal });
  connect.addEventListener(
    "click",
    () => {
      if (ready && state !== "connected")
        start("Autorisation Google en cours…", (signal) =>
          actions.authorize(signal),
        );
    },
    { signal },
  );
  disconnect.addEventListener(
    "click",
    () => {
      if (operation || state === "disconnected") return;
      actions.disconnect();
      showResult({ state: "disconnected" });
      renderControls();
    },
    { signal },
  );
  cancelButton.addEventListener("click", cancel, { signal });
  refresh.addEventListener(
    "click",
    () => {
      if (state === "connected")
        start("Consultation des ouvrages sur Drive…", (signal) =>
          actions.refresh(signal),
        );
    },
    { signal },
  );
  synchronize.addEventListener(
    "click",
    () => {
      const key = localBook.value;
      if (state === "connected" && key)
        start("Synchronisation de l’ouvrage…", (signal) =>
          actions.synchronize(key, signal),
        );
    },
    { signal },
  );
  localBook.addEventListener("change", renderControls, { signal });

  panel.hidden = false;
  if (panel.open) {
    opened = true;
    void prepare();
    void refreshLocal();
  }
  return {
    refreshLocal,
    cancel,
    settled: () => pending,
    report(result: DrivePanelResult) {
      if (operation || signal.aborted) return;
      showResult(result);
      renderControls();
    },
    dispose() {
      listeners.abort();
      operation?.abort();
      panel.hidden = true;
    },
  };
}
