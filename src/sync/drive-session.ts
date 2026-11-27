const driveFileScope = "https://www.googleapis.com/auth/drive.file";
const gisScriptUrl = "https://accounts.google.com/gsi/client";
const gisTimeoutMs = 15_000;

type AuthorizationPrompt = "" | "select_account" | "consent";
type AuthorizationResult = {
  kind: "authorized" | "cancelled" | "denied" | "popup-unavailable" | "busy";
};

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
} | null;

interface GisTokenApi {
  initTokenClient(configuration: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    callback(response: TokenResponse): void;
    error_callback(error: { type: string }): void;
  }): { requestAccessToken(options: { prompt: AuthorizationPrompt }): void };
}

interface Credential {
  readonly token: string;
  readonly expiresAt: number;
}

function browserGis(): GisTokenApi | undefined {
  const browser = globalThis as typeof globalThis & {
    google?: { accounts?: { oauth2?: GisTokenApi } };
  };
  const oauth = browser.google?.accounts?.oauth2;
  return typeof oauth?.initTokenClient === "function" ? oauth : undefined;
}

let loadingGis: Promise<boolean> | undefined;

function loadGisScript(): Promise<boolean> {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = gisScriptUrl;
    script.async = true;
    const timer = setTimeout(() => finish(false), gisTimeoutMs);
    function finish(ready: boolean) {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (!ready) script.remove();
      resolve(ready);
    }
    script.onload = () => finish(Boolean(browserGis()));
    script.onerror = () => finish(false);
    document.head.append(script);
  });
}

function prepareGis() {
  if (browserGis()) return Promise.resolve(true);
  return (loadingGis ??= loadGisScript().finally(() => {
    loadingGis = undefined;
  }));
}

function readCredential(
  response: TokenResponse,
  now: number,
): Credential | undefined {
  if (
    !response ||
    response.error ||
    typeof response.scope !== "string" ||
    response.scope.trim() !== driveFileScope
  )
    return;
  const token = response.access_token;
  const expiresAt = readExpiry(response.expires_in, now);
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
    expiresAt === undefined
  )
    return;
  return Object.freeze({ token, expiresAt });
}

function readExpiry(seconds: unknown, now: number) {
  if (typeof seconds !== "number" && typeof seconds !== "string") return;
  const expiresAt = now + Number(seconds) * 1_000;
  return Number.isFinite(expiresAt) && expiresAt > now ? expiresAt : undefined;
}

export function createDriveSession(clientId: string, now = Date.now) {
  const configuredClientId = clientId.trim();
  let credential: Credential | undefined;
  let cancel: (() => void) | undefined;

  function prepare() {
    return configuredClientId ? prepareGis() : Promise.resolve(false);
  }

  function active() {
    if (credential && credential.expiresAt <= now()) credential = undefined;
    return credential;
  }

  function authorize(
    prompt: AuthorizationPrompt = "",
  ): Promise<AuthorizationResult> {
    if (cancel) return Promise.resolve({ kind: "busy" });
    credential = undefined;
    const gis = browserGis();
    if (!gis || !configuredClientId) {
      return Promise.resolve({ kind: "popup-unavailable" });
    }

    return new Promise((resolve) => {
      function finish(kind: AuthorizationResult["kind"]) {
        if (cancel !== dismiss) return;
        cancel = undefined;
        resolve({ kind });
      }
      function dismiss() {
        finish("cancelled");
      }
      cancel = dismiss;

      try {
        const client = gis.initTokenClient({
          client_id: configuredClientId,
          scope: driveFileScope,
          include_granted_scopes: false,
          callback: (response) => {
            if (cancel !== dismiss) return;
            credential = readCredential(response, now());
            finish(credential ? "authorized" : "denied");
          },
          error_callback: ({ type }) =>
            finish(type === "popup_closed" ? "cancelled" : "popup-unavailable"),
        });
        // This call stays in the user's gesture, after explicit preparation.
        client.requestAccessToken({ prompt });
      } catch {
        finish("popup-unavailable");
      }
    });
  }

  function forget() {
    credential = undefined;
    cancel?.();
  }

  return { prepare, active, authorize, forget };
}
