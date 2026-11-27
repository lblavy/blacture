import { sha256 } from "../import/identity";

const drive = "https://www.googleapis.com/drive/v3";
const upload = "https://www.googleapis.com/upload/drive/v3/files";
const marker = "1";
const fileFields = "id,name,size,trashed,appProperties";
const binary = "application/octet-stream";
const chunkSize = 8 * 1024 * 1024;
const maxFileBytes: Record<DriveFile["kind"], number> = {
  edition: 128 * 1024 * 1024,
  resource: 16 * 1024 * 1024,
  progress: 768_000,
};

export interface DriveAuthorization {
  token: string;
  signal?: AbortSignal;
}

export interface DriveFile {
  id: string;
  kind: "edition" | "resource" | "progress";
  digest: string;
  size: number;
  editionHash?: string;
  title?: string;
}

export interface DriveUpload {
  file: DriveFile;
  location: string;
}

type UploadState = { nextOffset: number } | { finished: true };

export class DriveHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Google Drive a retourné le statut HTTP ${status}.`);
    this.name = "DriveHttpError";
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Réponse Google Drive invalide.");
  return value as Record<string, unknown>;
}

function driveId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new Error("Identifiant Google Drive invalide.");
  return value;
}

function driveFile(
  id: unknown,
  kind: unknown,
  digest: unknown,
  size: number,
  details: { editionHash?: unknown; title?: unknown } = {},
): DriveFile {
  if (kind !== "edition" && kind !== "resource" && kind !== "progress")
    throw new Error("Type de fichier Drive inconnu.");
  const file: DriveFile = {
    id: driveId(id),
    kind,
    digest: fileHash(digest, "Empreinte de fichier Drive invalide."),
    size: fileSize(kind, size),
  };
  if (details.editionHash !== undefined)
    file.editionHash = fileHash(details.editionHash);
  if (kind === "edition" && typeof details.title === "string")
    file.title = details.title.trim().slice(0, 240);
  return file;
}

function fileHash(value: unknown, message = "Clé d’édition Drive invalide.") {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(message);
  return value;
}

function fileSize(kind: DriveFile["kind"], size: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxFileBytes[kind])
    throw new Error("Taille de fichier Drive invalide.");
  return size;
}

function parseFile(value: unknown): DriveFile {
  const { id, name, size, trashed, appProperties } = record(value);
  if (trashed === true)
    throw new Error(
      "Le fichier Blacture a été placé dans la corbeille Google Drive.",
    );
  const properties = record(appProperties);
  if (
    properties.blacture !== marker ||
    typeof size !== "string" ||
    !/^\d+$/.test(size)
  )
    throw new Error("Métadonnées de fichier Drive invalides.");
  return driveFile(id, properties.kind, properties.digest, Number(size), {
    editionHash: properties.edition,
    title: name,
  });
}

function uploadAddress(location: string | null) {
  const url =
    location && URL.canParse(location) ? new URL(location) : undefined;
  if (
    url?.origin !== "https://www.googleapis.com" ||
    url.username ||
    url.password ||
    url.pathname !== "/upload/drive/v3/files" ||
    !url.searchParams.get("upload_id")
  ) {
    throw new Error("Adresse de transfert Google Drive invalide.");
  }
  return url.href;
}

async function readFileBytes(response: Response, size: number) {
  if (!response.body) throw new Error("Contenu Google Drive absent.");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > size) {
        await reader.cancel();
        throw new Error(
          "La taille du fichier Drive dépasse la taille attendue.",
        );
      }
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== size)
    throw new Error("La taille du fichier Drive est incomplète.");
  return bytes;
}

function confirmedOffset(response: Response, minimum: number, maximum: number) {
  const range = response.headers.get("Range");
  const match = range?.match(/^bytes=0-(\d+)$/);
  const next = range === null ? 0 : match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(next) || next < minimum || next > maximum)
    throw new Error("Position du transfert Google Drive invalide.");
  return next;
}

async function readUploadState(
  response: Response,
  file: DriveFile,
  minimum: number,
  maximum: number,
): Promise<UploadState> {
  if (response.status === 308)
    return {
      nextOffset: confirmedOffset(
        response,
        minimum,
        Math.min(maximum, file.size - 1),
      ),
    };
  const completed = parseFile(await response.json());
  if (
    maximum !== file.size ||
    completed.id !== file.id ||
    completed.digest !== file.digest ||
    completed.kind !== file.kind ||
    completed.size !== file.size ||
    completed.editionHash !== file.editionHash
  ) {
    throw new Error("Confirmation de transfert Google Drive incohérente.");
  }
  return { finished: true };
}

export function createDriveTransport(http: typeof fetch = globalThis.fetch) {
  async function request(
    auth: DriveAuthorization,
    url: string,
    init: RequestInit = {},
    allowPartial = false,
  ) {
    auth.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${auth.token}`);
    const response = await http(url, {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: auth.signal ?? null,
    });
    if (!response.ok && !(allowPartial && response.status === 308))
      throw new DriveHttpError(response.status);
    return response;
  }

  async function list(auth: DriveAuthorization) {
    const params = new URLSearchParams({
      q: `trashed = false and 'me' in owners and appProperties has { key='blacture' and value='${marker}' }`,
      spaces: "drive",
      fields: `nextPageToken,incompleteSearch,files(${fileFields})`,
      pageSize: "100",
    });
    const files: DriveFile[] = [];
    const visited = new Set<string>();
    for (;;) {
      const response = await request(auth, `${drive}/files?${params}`);
      const page = record(await response.json());
      if (page.incompleteSearch || !Array.isArray(page.files))
        throw new Error("La recherche Google Drive est incomplète.");
      for (const file of page.files) files.push(parseFile(file));
      const next = page.nextPageToken;
      if (next === undefined) return files;
      if (typeof next !== "string" || !next || visited.has(next))
        throw new Error("Pagination Google Drive invalide.");
      visited.add(next);
      params.set("pageToken", next);
    }
  }

  return {
    async account(auth: DriveAuthorization) {
      const response = await request(
        auth,
        `${drive}/about?fields=user(permissionId)`,
      );
      return driveId(record(record(await response.json()).user).permissionId);
    },
    list,
    async reserveId(auth: DriveAuthorization) {
      const response = await request(
        auth,
        `${drive}/files/generateIds?count=1&space=drive&type=files`,
      );
      const { ids } = record(await response.json());
      return driveId(Array.isArray(ids) ? ids[0] : undefined);
    },
    async metadata(auth: DriveAuthorization, id: string) {
      const response = await request(
        auth,
        `${drive}/files/${driveId(id)}?fields=${fileFields}`,
      );
      return parseFile(await response.json());
    },
    async download(auth: DriveAuthorization, descriptor: DriveFile) {
      const file = driveFile(
        descriptor.id,
        descriptor.kind,
        descriptor.digest,
        descriptor.size,
        descriptor,
      );
      const response = await request(
        auth,
        `${drive}/files/${file.id}?alt=media`,
      );
      const bytes = await readFileBytes(response, file.size);
      if ((await sha256(bytes)) !== file.digest)
        throw new Error("L’empreinte du fichier Drive ne correspond pas.");
      return bytes;
    },
    async startUpload(
      auth: DriveAuthorization,
      descriptor: DriveFile,
    ): Promise<DriveUpload> {
      const file = driveFile(
        descriptor.id,
        descriptor.kind,
        descriptor.digest,
        descriptor.size,
        descriptor,
      );
      const fields = new URLSearchParams({
        uploadType: "resumable",
        fields: fileFields,
      });
      const response = await request(auth, `${upload}?${fields}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": binary,
          "X-Upload-Content-Length": String(file.size),
        },
        body: JSON.stringify({
          id: file.id,
          name:
            file.title || `blacture-${file.kind}-${file.digest.slice(0, 24)}`,
          mimeType: binary,
          appProperties: {
            blacture: marker,
            kind: file.kind,
            digest: file.digest,
            edition: file.editionHash,
          },
        }),
      });
      return {
        file,
        location: uploadAddress(response.headers.get("Location")),
      };
    },
    async probeUpload(auth: DriveAuthorization, transfer: DriveUpload) {
      const response = await request(
        auth,
        uploadAddress(transfer.location),
        {
          method: "PUT",
          headers: { "Content-Range": `bytes */${transfer.file.size}` },
        },
        true,
      );
      return readUploadState(response, transfer.file, 0, transfer.file.size);
    },
    async sendChunk(
      auth: DriveAuthorization,
      transfer: DriveUpload,
      bytes: Uint8Array<ArrayBuffer>,
      offset: number,
    ) {
      const size = transfer.file.size;
      if (
        bytes.length !== size ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset >= size
      )
        throw new Error(
          "Position ou taille du transfert Google Drive invalide.",
        );
      const end = Math.min(offset + chunkSize, size);
      const response = await request(
        auth,
        uploadAddress(transfer.location),
        {
          method: "PUT",
          headers: {
            "Content-Type": binary,
            "Content-Range": `bytes ${offset}-${end - 1}/${size}`,
          },
          body: bytes.subarray(offset, end),
        },
        true,
      );
      return readUploadState(response, transfer.file, offset + 1, end);
    },
  };
}
