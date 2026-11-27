import {
  listBooks,
  readDriveBinding,
  readDriveProgressCursor,
  readDriveSelections,
  readProgressJournal,
  trackDriveEdition,
} from "../storage";
import { createDriveLibrary, type ConnectedDrive } from "./drive-library";
import { mountDrivePanel, type DrivePanelResult } from "./drive-panel";
import { createDriveSession } from "./drive-session";
import { DriveHttpError } from "./drive-transport";

const lockName = "blacture-drive";
const backgroundInterval = 60_000;

const knownErrors = new Map([
  [
    "Ce profil Blacture est associé à un autre compte Google Drive.",
    "Ce profil est associé à un autre compte Drive. Choisissez le compte associé.",
  ],
  [
    "Cette édition est déjà présente dans Drive avec un autre rendu.",
    "Cette édition a un autre rendu sur Drive. Les copies sont conservées.",
  ],
  [
    "Une copie locale de cette édition possède un autre rendu.",
    "Une copie locale possède un autre rendu. Les copies sont conservées.",
  ],
  [
    "Une autre édition de cet ouvrage est déjà présente dans la bibliothèque.",
    "Une autre édition est présente sur cet appareil. Exportez-la et retirez-la depuis Sauvegarde locale pour télécharger celle de Drive.",
  ],
  [
    "Remplacement annulé. L’édition locale est conservée.",
    "Remplacement annulé. L’édition locale est conservée.",
  ],
  [
    "Le lot de progression utilise un index de lecture différent.",
    "Les passages de cette édition diffèrent entre appareils. La progression locale est conservée.",
  ],
]);

function failure(error: unknown): string {
  if (error instanceof DriveHttpError) {
    if (error.status === 403)
      return "Google Drive refuse l’accès ou le quota est atteint. Les données locales sont conservées.";
    if (error.status === 429)
      return "Google Drive limite les requêtes. Vous pouvez réessayer plus tard.";
  }
  return (
    (error instanceof Error ? knownErrors.get(error.message) : undefined) ??
    "Synchronisation impossible. Les données locales sont conservées."
  );
}

export function startDriveController(
  panelElement: HTMLDetailsElement,
  clientId: string,
  refreshCatalog: () => void,
) {
  const session = createDriveSession(clientId);
  const library = createDriveLibrary();
  let accountId: string | undefined;
  let everBound = false;
  let selectAccount = false;
  let frozen = false;
  let background:
    { controller: AbortController; task: Promise<void> } | undefined;

  function disconnect() {
    session.forget();
    accountId = undefined;
    background?.controller.abort();
  }

  function reconnect(
    message = "Reprenez la connexion Google Drive. Les données locales sont conservées.",
  ): DrivePanelResult {
    disconnect();
    return { state: "reconnect", message };
  }

  function connection(signal: AbortSignal): ConnectedDrive | undefined {
    const credential = session.active();
    if (!credential || !accountId) return undefined;
    return { auth: { token: credential.token, signal }, accountId };
  }

  function failed(error: unknown): DrivePanelResult {
    return error instanceof DriveHttpError && error.status === 401
      ? reconnect()
      : { state: "connected", message: failure(error) };
  }

  async function authorize(signal: AbortSignal): Promise<DrivePanelResult> {
    const cancel = () => session.forget();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const prompt = everBound && !selectAccount ? "" : "select_account";
      const result = await session.authorize(prompt);
      if (result.kind !== "authorized")
        return {
          state: "disconnected",
          message:
            "Autorisation Google Drive interrompue. La lecture locale reste disponible.",
        };
      signal.throwIfAborted();
      const credential = session.active();
      if (!credential) return reconnect();
      const verified = await library.connect({
        token: credential.token,
        signal,
      });
      accountId = verified.accountId;
      selectAccount = false;
      return {
        state: "connected",
        message:
          "Connecté à Google Drive. Choisissez un ouvrage à synchroniser ou à télécharger.",
      };
    } catch (error) {
      selectAccount = true;
      return reconnect(failure(error));
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async function run(
    signal: AbortSignal,
    work: (connected: ConnectedDrive) => Promise<DrivePanelResult>,
  ): Promise<DrivePanelResult> {
    try {
      return await navigator.locks.request(lockName, { signal }, async () => {
        const current = connection(signal);
        if (!current) return reconnect();
        if (!navigator.onLine)
          return {
            state: "connected",
            message: "Hors ligne. Les données locales sont conservées.",
          };
        return work(current);
      });
    } catch (error) {
      return failed(error);
    }
  }

  const panel = mountDrivePanel(panelElement, {
    async prepare() {
      const [ready, binding] = await Promise.all([
        session.prepare(),
        readDriveBinding(),
      ]);
      everBound = Boolean(binding);
      return ready;
    },
    authorize,
    disconnect,
    localBooks: listBooks,
    refresh: (signal) =>
      run(signal, async (current) => ({
        state: "connected",
        books: (await library.list(current)).remote,
        message: "Bibliothèque Google Drive actualisée.",
      })),
    synchronize: (key, signal) =>
      run(signal, async (current) => {
        await library.synchronize(current, key);
        await trackDriveEdition(current.accountId, key);
        everBound = true;
        refreshCatalog();
        return {
          state: "connected",
          message: "Ouvrage et progression synchronisés.",
        };
      }),
    download: (id, signal) =>
      run(signal, async (current) => {
        await library.download(current, id, (title) =>
          window.confirm(
            `Remplacer « ${title} » par l’édition de Drive ? Blacture conservera la progression récupérable et une sauvegarde de l’édition qui sera remplacée. Pour garder une sauvegarde plus ancienne, exportez-la avant de continuer.`,
          ),
        );
        everBound = true;
        refreshCatalog();
        return {
          state: "connected",
          message:
            "Ouvrage disponible hors ligne. Progression Drive récupérée.",
        };
      }),
  });

  async function hasPending(id: string, key: string, signal: AbortSignal) {
    const [journal, cursor] = await Promise.all([
      readProgressJournal(key, signal),
      readDriveProgressCursor(id, key),
    ]);
    return (journal?.events.at(-1)?.clock ?? 0) > cursor.sentThrough;
  }

  async function synchronizeSelections(signal: AbortSignal, pull: boolean) {
    const current = connection(signal);
    if (!current || (await readDriveBinding()) !== current.accountId) return;
    let changed = false;
    for (const key of await readDriveSelections(current.accountId)) {
      if (!pull && !(await hasPending(current.accountId, key, signal)))
        continue;
      await library.synchronize(current, key, true);
      changed = true;
    }
    if (changed) {
      refreshCatalog();
      panel.report({
        state: "connected",
        message: "Progression des ouvrages suivis synchronisée.",
      });
    }
  }

  function synchronizeInBackground(pull: boolean) {
    if (
      frozen ||
      !accountId ||
      background ||
      !navigator.onLine ||
      document.hidden
    )
      return;
    const controller = new AbortController();
    const { signal } = controller;
    const task = navigator.locks
      .request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock || signal.aborted) return;
        if (!connection(signal)) {
          panel.report(reconnect());
          return;
        }
        await synchronizeSelections(signal, pull);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) panel.report(failed(error));
      })
      .finally(() => {
        background = undefined;
      });
    background = { controller, task };
  }

  function onReturn() {
    synchronizeInBackground(true);
  }
  window.addEventListener("online", onReturn);
  window.addEventListener("focus", onReturn);
  window.setInterval(() => synchronizeInBackground(false), backgroundInterval);

  return {
    refreshLocal: panel.refreshLocal,
    async settleForUpdate() {
      frozen = true;
      panelElement.inert = true;
      background?.controller.abort();
      panel.cancel();
      await Promise.all([background?.task, panel.settled()]);
      return () => {
        frozen = false;
        panelElement.inert = false;
      };
    },
  };
}
