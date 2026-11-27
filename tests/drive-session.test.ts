import { afterEach, expect, it, vi } from "vitest";
import { createDriveSession } from "../src/sync/drive-session";

const clientId = "synthetic.apps.googleusercontent.com";
const scope = "https://www.googleapis.com/auth/drive.file";
const scriptUrl = "https://accounts.google.com/gsi/client";

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
} | null;

interface ClientConfiguration {
  callback(response: TokenResponse): void;
  error_callback(error: { type: string }): void;
}

const granted = { access_token: "fictitious-token", expires_in: 120, scope };

function installGis() {
  const requestAccessToken = vi.fn();
  const initTokenClient = vi.fn<
    (configuration: ClientConfiguration) => {
      requestAccessToken: typeof requestAccessToken;
    }
  >(() => ({
    requestAccessToken,
  }));
  vi.stubGlobal("google", { accounts: { oauth2: { initTokenClient } } });
  return {
    initTokenClient,
    requestAccessToken,
    configuration: (index = 0) => initTokenClient.mock.calls[index]![0],
  };
}

function gisScripts() {
  return [...document.head.querySelectorAll<HTMLScriptElement>("script")];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const element of gisScripts()) element.remove();
});

it("loads the exact Google script on preparation and shares an ongoing load", async () => {
  const first = createDriveSession(clientId);
  const second = createDriveSession(clientId);
  expect(gisScripts()).toEqual([]);
  expect(first.active()).toBeUndefined();
  const preparing = first.prepare();
  const alsoPreparing = second.prepare();
  const [script, extraScript] = gisScripts();
  expect(script?.src).toBe(scriptUrl);
  expect(extraScript).toBeUndefined();
  const gis = installGis();
  script?.dispatchEvent(new Event("load"));
  expect(await Promise.all([preparing, alsoPreparing])).toEqual([true, true]);
  expect(gis.initTokenClient).not.toHaveBeenCalled();
  expect(await first.prepare()).toBe(true);
  expect(gisScripts()).toHaveLength(1);
});

it("retrieves the script again after a failure or a response without GIS", async () => {
  const session = createDriveSession(clientId);
  const failed = session.prepare();
  const firstScript = gisScripts()[0]!;
  firstScript.dispatchEvent(new Event("error"));
  expect(await failed).toBe(false);
  expect(firstScript.isConnected).toBe(false);

  const incomplete = session.prepare();
  gisScripts()[0]!.dispatchEvent(new Event("load"));
  expect(await incomplete).toBe(false);
  expect(gisScripts()).toHaveLength(0);

  const retry = session.prepare();
  const script = gisScripts()[0]!;
  installGis();
  script.dispatchEvent(new Event("load"));
  expect(await retry).toBe(true);
});

it("leaves an unavailable loader retryable after a stalled request", async () => {
  vi.useFakeTimers();
  const session = createDriveSession(clientId);
  const stalled = session.prepare();
  const script = gisScripts()[0]!;
  await vi.runAllTimersAsync();
  expect(await stalled).toBe(false);
  expect(script.isConnected).toBe(false);
  const retried = session.prepare();
  installGis();
  gisScripts()[0]!.dispatchEvent(new Event("load"));
  expect(await retried).toBe(true);
});

it("does not load or open a popup for an unavailable or unconfigured client", async () => {
  const unprepared = createDriveSession(clientId);
  expect(await unprepared.authorize()).toEqual({ kind: "popup-unavailable" });
  const gis = installGis();
  const unconfigured = createDriveSession("");
  expect(await unconfigured.prepare()).toBe(false);
  expect(await unconfigured.authorize()).toEqual({ kind: "popup-unavailable" });
  expect(gis.initTokenClient).not.toHaveBeenCalled();
  expect(gisScripts()).toHaveLength(0);
});

it("requests only drive.file synchronously and drops expired credentials", async () => {
  const gis = installGis();
  let time = 100;
  const session = createDriveSession(clientId, () => time);
  const result = session.authorize("select_account");
  expect(gis.initTokenClient).toHaveBeenCalledWith(
    expect.objectContaining({
      client_id: clientId,
      scope,
      include_granted_scopes: false,
    }),
  );
  expect(gis.requestAccessToken).toHaveBeenCalledWith({
    prompt: "select_account",
  });
  gis.configuration().callback(granted);
  expect(await result).toEqual({ kind: "authorized" });
  expect(session.active()).toEqual({
    token: granted.access_token,
    expiresAt: 120_100,
  });
  expect(createDriveSession(clientId).active()).toBeUndefined();
  time = 120_100;
  expect(session.active()).toBeUndefined();
});

it.each(
  [
    { ...granted, error: "access_denied" },
    { ...granted, scope: "" },
    { ...granted, scope: scope + " other.scope" },
    { ...granted, expires_in: "invalid" },
    { ...granted, expires_in: 0 },
    { ...granted, access_token: "" },
    { ...granted, access_token: "two parts" },
    { ...granted, access_token: "fictitious-token\n" },
    { ...granted, scope: [scope] },
    { ...granted, access_token: 123 },
    { ...granted, expires_in: true },
    null,
  ].map((response) => [response] as const),
)("denies an unusable token response", async (response) => {
  const gis = installGis();
  const session = createDriveSession(clientId);
  const result = session.authorize();
  expect(gis.requestAccessToken).toHaveBeenCalledWith({ prompt: "" });
  gis.configuration().callback(response);
  expect(await result).toEqual({ kind: "denied" });
  expect(session.active()).toBeUndefined();
});

it.each([
  { type: "popup_closed", kind: "cancelled" },
  { type: "popup_failed_to_open", kind: "popup-unavailable" },
])("handles $type without retaining a late grant", async ({ type, kind }) => {
  const gis = installGis();
  const session = createDriveSession(clientId);
  const result = session.authorize();
  gis.configuration().error_callback({ type });
  gis.configuration().callback(granted);
  expect(await result).toEqual({ kind });
  expect(session.active()).toBeUndefined();
});

it("ignores overlapping and stale callbacks after closing the local session", async () => {
  const gis = installGis();
  const session = createDriveSession(clientId);
  const first = session.authorize();
  expect(await session.authorize()).toEqual({ kind: "busy" });
  expect(gis.requestAccessToken).toHaveBeenCalledTimes(1);
  session.forget();
  expect(await first).toEqual({ kind: "cancelled" });
  const second = session.authorize();
  gis.configuration().callback(granted);
  gis.configuration().error_callback({ type: "popup_closed" });
  expect(session.active()).toBeUndefined();
  gis.configuration(1).callback({ ...granted, expires_in: "120" });
  expect(await second).toEqual({ kind: "authorized" });
  session.forget();
  expect(session.active()).toBeUndefined();
});

it("recovers from an exception while opening the popup", async () => {
  const gis = installGis();
  gis.requestAccessToken.mockImplementationOnce(() => {
    throw new Error("Simulated popup failure");
  });
  const session = createDriveSession(clientId);
  expect(await session.authorize()).toEqual({ kind: "popup-unavailable" });
  const result = session.authorize();
  gis.configuration(1).callback(granted);
  expect(await result).toEqual({ kind: "authorized" });
});
