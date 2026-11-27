import { afterEach, expect, it, vi } from "vitest";
import { startInstallSupport } from "../src/install-support";

const cleanup: (() => void)[] = [];

function setup({
  standalone = false,
  storage,
}: {
  standalone?: boolean;
  storage?: Partial<StorageManager>;
} = {}) {
  const mode = Object.assign(new EventTarget(), { matches: standalone });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mode),
  );
  vi.stubGlobal("navigator", { storage });
  const controls = {
    installButton: Object.assign(document.createElement("button"), {
      hidden: true,
    }),
    installStatus: document.createElement("p"),
    persistButton: Object.assign(document.createElement("button"), {
      hidden: true,
    }),
    persistStatus: document.createElement("p"),
  };
  const stop = startInstallSupport(controls);
  cleanup.push(stop);
  return { ...controls, mode, stop };
}

function offerInstallation(outcome: "accepted" | "dismissed" = "accepted") {
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    {
      prompt: vi.fn(async () => ({ outcome })),
      userChoice: Promise.resolve({ outcome }),
    },
  );
  window.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.unstubAllGlobals();
});

it("attend l’offre du navigateur et n’ouvre la boîte d’installation qu’au clic", async () => {
  const { installButton, installStatus } = setup();
  expect(installButton.hidden).toBe(true);
  const invitation = offerInstallation("dismissed");
  expect(invitation.defaultPrevented).toBe(true);
  expect(installButton.hidden).toBe(false);
  expect(invitation.prompt).not.toHaveBeenCalled();
  installButton.click();
  expect(invitation.prompt).toHaveBeenCalledOnce();
  expect(installButton.hidden).toBe(true);
  await vi.waitFor(() =>
    expect(installStatus.textContent).toContain("annulée"),
  );
  installButton.click();
  expect(invitation.prompt).toHaveBeenCalledOnce();
  offerInstallation();
  expect(installButton.hidden).toBe(false);
});

it("cache l’installation en mode autonome et après confirmation du navigateur", () => {
  const { installButton, mode } = setup({ standalone: true });
  const invitation = offerInstallation();
  expect(installButton.hidden).toBe(true);
  expect(invitation.defaultPrevented).toBe(false);
  mode.matches = false;
  mode.dispatchEvent(new Event("change"));
  offerInstallation();
  expect(installButton.hidden).toBe(false);
  window.dispatchEvent(new Event("appinstalled"));
  expect(installButton.hidden).toBe(true);
  offerInstallation();
  expect(installButton.hidden).toBe(true);
});

it("annonce une installation acceptée depuis le dialogue et masque les offres suivantes", async () => {
  const { installButton, installStatus } = setup();
  offerInstallation();
  installButton.click();
  await vi.waitFor(() =>
    expect(installStatus.textContent).toContain("Installation acceptée"),
  );
  expect(offerInstallation().defaultPrevented).toBe(false);
  expect(installButton.hidden).toBe(true);
});

it("signale l’échec du dialogue sans consommer une nouvelle offre", async () => {
  const { installButton, installStatus } = setup();
  const invitation = offerInstallation();
  invitation.prompt.mockRejectedValueOnce(new Error("Dialogue indisponible"));
  installButton.click();
  await vi.waitFor(() => expect(installStatus.textContent).toContain("échoué"));
  expect(installButton.hidden).toBe(true);
  offerInstallation();
  expect(installButton.hidden).toBe(false);
});

it("demande le stockage persistant uniquement au clic et confirme l’état obtenu", async () => {
  const persisted = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const persist = vi.fn().mockResolvedValue(true);
  const { persistButton, persistStatus } = setup({
    storage: { persisted, persist },
  });
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("non activé"),
  );
  expect(persist).not.toHaveBeenCalled();
  expect(persistButton.disabled).toBe(false);
  expect(persistButton.hidden).toBe(false);
  persistButton.click();
  expect(persist).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("Stockage persistant activé"),
  );
  expect(persisted).toHaveBeenCalledTimes(2);
  expect(persistButton.disabled).toBe(true);
});

it("annonce le refus de persistance et garde une demande explicite possible", async () => {
  const persist = vi.fn().mockResolvedValue(false);
  const persisted = vi.fn().mockResolvedValue(false);
  const { persistButton, persistStatus } = setup({
    storage: { persisted, persist },
  });
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("non activé"),
  );
  persistButton.click();
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("n’a pas accordé"),
  );
  expect(persistButton.disabled).toBe(false);
});

it("distingue une permission accordée sans confirmation de stockage persistant", async () => {
  const { persistButton, persistStatus } = setup({
    storage: {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockResolvedValue(true),
    },
  });
  await vi.waitFor(() => expect(persistButton.disabled).toBe(false));
  persistButton.click();
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("non confirmé"),
  );
  expect(persistButton.disabled).toBe(false);
});

it("autorise une demande explicite après un échec de la vérification initiale", async () => {
  const persisted = vi
    .fn()
    .mockRejectedValueOnce(new Error("État indisponible"))
    .mockResolvedValueOnce(true);
  const persist = vi.fn().mockResolvedValue(true);
  const { persistButton, persistStatus } = setup({
    storage: { persisted, persist },
  });
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("Vérification"),
  );
  expect(persist).not.toHaveBeenCalled();
  persistButton.click();
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("Stockage persistant activé"),
  );
});

it("signale les API absentes ou une demande rejetée", async () => {
  const unsupported = setup();
  expect(unsupported.persistButton.disabled).toBe(true);
  expect(unsupported.persistButton.hidden).toBe(true);
  expect(unsupported.persistStatus.textContent).toContain("ne propose pas");
  unsupported.stop();
  const { persistButton, persistStatus } = setup({
    storage: {
      persisted: vi.fn().mockResolvedValue(false),
      persist: vi.fn().mockRejectedValue(new Error("Permissions")),
    },
  });
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("non activé"),
  );
  persistButton.click();
  await vi.waitFor(() =>
    expect(persistStatus.textContent).toContain("impossible"),
  );
  expect(persistButton.disabled).toBe(false);
});
