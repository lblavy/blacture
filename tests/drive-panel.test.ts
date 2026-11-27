import { afterEach, expect, it, vi } from "vitest";
import page from "../index.html?raw";
import {
  mountDrivePanel,
  type DrivePanelActions,
  type DrivePanelResult,
} from "../src/sync/drive-panel";

const connected: DrivePanelResult = { state: "connected" };
const dangerousTitle = "<img src=tracker alt=test> Un ouvrage";

function fixture(overrides: Partial<DrivePanelActions> = {}) {
  document.body.innerHTML = new DOMParser().parseFromString(
    page,
    "text/html",
  ).body.innerHTML;
  const panel = document.querySelector<HTMLDetailsElement>("#drive-panel")!;
  const actions = {
    prepare: vi.fn<DrivePanelActions["prepare"]>().mockResolvedValue(true),
    authorize: vi
      .fn<DrivePanelActions["authorize"]>()
      .mockResolvedValue(connected),
    disconnect: vi.fn<DrivePanelActions["disconnect"]>(),
    localBooks: vi
      .fn<DrivePanelActions["localBooks"]>()
      .mockResolvedValue([{ key: "livre-a", title: "Un livre local" }]),
    refresh: vi.fn<DrivePanelActions["refresh"]>().mockResolvedValue({
      ...connected,
      books: [{ key: "livre-b", title: dangerousTitle }],
    }),
    synchronize: vi
      .fn<DrivePanelActions["synchronize"]>()
      .mockResolvedValue(connected),
    download: vi
      .fn<DrivePanelActions["download"]>()
      .mockResolvedValue(connected),
    ...overrides,
  };
  const mounted = mountDrivePanel(panel, actions);
  const button = (id: string) =>
    panel.querySelector<HTMLButtonElement>(`#drive-${id}`)!;
  const select = panel.querySelector<HTMLSelectElement>("#drive-local-book")!;
  const list = panel.querySelector<HTMLUListElement>("#drive-remote-books")!;
  const status = panel.querySelector<HTMLElement>("#drive-status")!;
  function open() {
    panel.open = true;
    panel.dispatchEvent(new Event("toggle"));
  }
  async function connect() {
    open();
    await vi.waitFor(() => expect(button("connect").disabled).toBe(false));
    button("connect").click();
    await mounted.settled();
  }
  return {
    panel,
    actions,
    mounted,
    button,
    select,
    list,
    status,
    open,
    connect,
  };
}

afterEach(() => document.body.replaceChildren());

it("prépare la connexion seulement à l’ouverture et attend un geste pour autoriser", async () => {
  const { actions, open, panel, button, mounted } = fixture();
  expect(panel.hidden).toBe(false);
  expect(actions.prepare).not.toHaveBeenCalled();
  expect(actions.authorize).not.toHaveBeenCalled();
  open();
  expect(actions.prepare).toHaveBeenCalledOnce();
  expect(button("connect").disabled).toBe(true);
  await vi.waitFor(() => expect(button("connect").disabled).toBe(false));
  expect(actions.authorize).not.toHaveBeenCalled();
  button("connect").click();
  expect(actions.authorize).toHaveBeenCalledWith(expect.any(AbortSignal));
  await mounted.settled();
  expect(actions.refresh).not.toHaveBeenCalled();
  expect(actions.synchronize).not.toHaveBeenCalled();
});

it("propose de réessayer après un chargement indisponible", async () => {
  const prepare = vi
    .fn<DrivePanelActions["prepare"]>()
    .mockRejectedValueOnce(new Error("erreur de préparation simulée"))
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  const { button, open, status } = fixture({ prepare });
  open();
  await vi.waitFor(() => expect(button("load").hidden).toBe(false));
  expect(status.textContent).toMatch(/indisponible/u);
  expect(button("connect").disabled).toBe(true);
  button("load").click();
  await vi.waitFor(() => expect(button("load").hidden).toBe(false));
  button("load").click();
  await vi.waitFor(() => expect(button("connect").disabled).toBe(false));
  expect(prepare).toHaveBeenCalledTimes(3);
});

it("synchronise uniquement un ouvrage explicitement sélectionné", async () => {
  const { actions, button, connect, mounted, select } = fixture();
  await connect();
  await vi.waitFor(() => expect(select.options).toHaveLength(2));
  expect(select.value).toBe("");
  button("sync").click();
  expect(actions.synchronize).not.toHaveBeenCalled();
  select.value = "livre-a";
  select.dispatchEvent(new Event("change"));
  button("sync").click();
  await mounted.settled();
  expect(actions.synchronize).toHaveBeenCalledExactlyOnceWith(
    "livre-a",
    expect.any(AbortSignal),
  );
  expect(actions.download).not.toHaveBeenCalled();
});

it("affiche les titres Drive en texte et télécharge uniquement sur demande", async () => {
  const { actions, button, connect, list, mounted } = fixture();
  await connect();
  button("refresh").click();
  await mounted.settled();
  expect(list.textContent).toContain(dangerousTitle);
  expect(list.querySelector("img")).toBeNull();
  expect(actions.download).not.toHaveBeenCalled();
  const download = list.querySelector<HTMLButtonElement>("button")!;
  expect(download.getAttribute("aria-label")).toContain(dangerousTitle);
  download.click();
  await mounted.settled();
  expect(actions.download).toHaveBeenCalledExactlyOnceWith(
    "livre-b",
    expect.any(AbortSignal),
  );
  expect(actions.synchronize).not.toHaveBeenCalled();
});

it("annule l’opération et ignore un résultat OAuth tardif", async () => {
  let authorizeFinished: ((value: DrivePanelResult) => void) | undefined;
  const authorize = vi.fn<DrivePanelActions["authorize"]>().mockImplementation(
    () =>
      new Promise((resolve) => {
        authorizeFinished = resolve;
      }),
  );
  const { button, mounted, open, status } = fixture({ authorize });
  open();
  await vi.waitFor(() => expect(button("connect").disabled).toBe(false));
  button("connect").click();
  const operationSignal = authorize.mock.calls[0]![0];
  expect(button("cancel").hidden).toBe(false);
  mounted.report({ state: "disconnected", message: "État automatique." });
  expect(status.textContent).toContain("Autorisation Google en cours");
  button("cancel").click();
  expect(operationSignal.aborted).toBe(true);
  authorizeFinished?.(connected);
  await mounted.settled();
  expect(status.textContent).toMatch(/annulée/u);
  expect(button("disconnect").hidden).toBe(true);
  mounted.report({ state: "reconnect", message: "Modifications en attente." });
  expect(status.textContent).toBe("Modifications en attente.");
  mounted.dispose();
  mounted.report({ state: "connected", message: "Modifications envoyées." });
  expect(status.textContent).toBe("Modifications en attente.");
});

it("distingue la reconnexion demandée et présente une erreur générique en cas de rejet", async () => {
  const authorize = vi
    .fn<DrivePanelActions["authorize"]>()
    .mockRejectedValueOnce(new Error("TLS request diagnostic not shown"))
    .mockResolvedValue({ state: "reconnect", message: "Session expirée." });
  const { button, connect, mounted, status } = fixture({ authorize });
  await connect();
  expect(status.textContent).toMatch(/impossible/u);
  expect(status.textContent).not.toContain("TLS");
  button("connect").click();
  await mounted.settled();
  expect(status.textContent).toBe("Session expirée.");
  expect(button("connect").textContent).toContain("Reprendre");
  expect(button("disconnect").hidden).toBe(false);
  button("disconnect").click();
  expect(status.textContent).toBe("Google Drive déconnecté.");
});

it("retire la liste du compte après déconnexion", async () => {
  const { actions, button, connect, list, mounted, select } = fixture();
  await connect();
  await vi.waitFor(() => expect(select.options).toHaveLength(2));
  select.value = "livre-a";
  select.dispatchEvent(new Event("change"));
  button("refresh").click();
  await mounted.settled();
  const previousButton = list.querySelector<HTMLButtonElement>("button")!;
  button("disconnect").click();
  expect(actions.disconnect).toHaveBeenCalledOnce();
  expect(list.children).toHaveLength(0);
  previousButton.click();
  expect(actions.download).not.toHaveBeenCalled();
  button("connect").click();
  await mounted.settled();
  expect(select.value).toBe("");
  expect(button("sync").disabled).toBe(true);
});

it("préserve l’état local même quand le catalogue Drive est vide", async () => {
  const refresh = vi
    .fn<DrivePanelActions["refresh"]>()
    .mockResolvedValue({ state: "connected", books: [] });
  const { button, panel, connect, mounted, select } = fixture({ refresh });
  await connect();
  button("refresh").click();
  await mounted.settled();
  expect(panel.querySelector<HTMLElement>("#drive-remote-empty")?.hidden).toBe(
    false,
  );
  expect(select.options).toHaveLength(2);
  button("disconnect").click();
  expect(panel.querySelector<HTMLElement>("#drive-remote-empty")?.hidden).toBe(
    true,
  );
});

it("distingue la lecture locale et garde le choix pendant une nouvelle lecture du catalogue", async () => {
  const book = { key: "livre-a", title: "Un ouvrage" };
  const localBooks = vi
    .fn<DrivePanelActions["localBooks"]>()
    .mockResolvedValueOnce([book])
    .mockRejectedValueOnce(new Error("erreur IndexedDB simulée"))
    .mockResolvedValue([book]);
  const { connect, mounted, select, status, panel } = fixture({ localBooks });
  await connect();
  await vi.waitFor(() => expect(select.options).toHaveLength(2));
  select.value = book.key;
  const error = panel.querySelector<HTMLElement>("#drive-local-error")!;
  await mounted.refreshLocal();
  expect(error.textContent).toMatch(/bibliothèque locale/u);
  expect(status.textContent).toBe("Connecté à Google Drive.");
  expect(select.value).toBe(book.key);
  await mounted.refreshLocal();
  expect(select.value).toBe(book.key);
  expect(error.textContent).toBe("");
  mounted.dispose();
  await mounted.refreshLocal();
  expect(localBooks).toHaveBeenCalledTimes(3);
});
