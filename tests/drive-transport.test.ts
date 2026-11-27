// @vitest-environment node
import { expect, it, vi } from "vitest";
import { sha256 } from "../src/import/identity";
import { createDriveTransport } from "../src/sync/drive-transport";

const authorization = {
  token: "test-token",
  signal: new AbortController().signal,
};
const bytes = new TextEncoder().encode("Données fictives.");
const digest = await sha256(bytes);
const path = "https://www.googleapis.com/upload/drive/v3/files?upload_id=test";

function metadata(
  file = "object_1",
  content = digest,
  size = bytes.length,
  kind = "progress",
) {
  return {
    id: file,
    size: String(size),
    appProperties: { blacture: "1", kind, digest: content },
  };
}

it("identifie le compte et recherche les fichiers de l’application sur toutes les pages", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ user: { permissionId: "account_1" } }),
    )
    .mockResolvedValueOnce(
      Response.json({ files: [metadata()], nextPageToken: "second" }),
    )
    .mockResolvedValueOnce(Response.json({ files: [metadata("object_2")] }));
  const drive = createDriveTransport(http);
  expect(await drive.account(authorization)).toBe("account_1");
  expect(await drive.list(authorization)).toEqual([
    { id: "object_1", kind: "progress", digest, size: bytes.length },
    { id: "object_2", kind: "progress", digest, size: bytes.length },
  ]);
  const [request, options] = http.mock.calls.at(-1)!;
  const url = new URL(String(request));
  expect(url.searchParams.get("q")).toContain("'me' in owners");
  expect(url.searchParams.get("pageToken")).toBe("second");
  expect(options?.redirect).toBe("error");
  expect(new Headers(options?.headers).get("Authorization")).toBe(
    "Bearer test-token",
  );
});

it("contrôle la taille et l’empreinte des téléchargements", async () => {
  const file = {
    id: "object_1",
    kind: "progress",
    digest,
    size: bytes.length,
  } as const;
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(bytes))
    .mockResolvedValueOnce(new Response(bytes.slice(1)))
    .mockResolvedValueOnce(new Response(new Uint8Array(bytes.length)))
    .mockResolvedValueOnce(new Response(new Uint8Array(bytes.length + 1)));
  const drive = createDriveTransport(http);
  expect(await drive.download(authorization, file)).toEqual(bytes);
  await expect(drive.download(authorization, file)).rejects.toThrow(/taille/u);
  await expect(drive.download(authorization, file)).rejects.toThrow(
    /empreinte/u,
  );
  await expect(drive.download(authorization, file)).rejects.toThrow(/taille/u);
});

it("rejette un lot surdimensionné et un fichier mis à la corbeille", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...metadata(), trashed: true }));
  const drive = createDriveTransport(http);
  await expect(
    drive.download(authorization, {
      id: "object_1",
      kind: "progress",
      digest,
      size: 768_001,
    }),
  ).rejects.toThrow(/taille/iu);
  expect(http).not.toHaveBeenCalled();
  await expect(drive.metadata(authorization, "object_1")).rejects.toThrow(
    /corbeille/u,
  );
});

it("réserve un identifiant puis traite les accusés de réception d’un transfert découpé", async () => {
  const chunkSize = 8 * 1024 * 1024;
  const buffer = new Uint8Array(chunkSize + 4);
  const content = await sha256(buffer);
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ids: ["object_1"] }))
    .mockResolvedValueOnce(new Response(null, { headers: { Location: path } }))
    .mockResolvedValueOnce(
      new Response(null, {
        status: 308,
        headers: { Range: `bytes=0-${chunkSize - 1}` },
      }),
    )
    .mockResolvedValueOnce(
      Response.json(metadata("object_1", content, buffer.length, "resource")),
    );
  const drive = createDriveTransport(http);
  const id = await drive.reserveId(authorization);
  const transfer = await drive.startUpload(authorization, {
    id,
    kind: "resource",
    digest: content,
    size: buffer.length,
  });
  const first = await drive.sendChunk(authorization, transfer, buffer, 0);
  expect(first).toEqual({ nextOffset: chunkSize });
  expect(
    await drive.sendChunk(authorization, transfer, buffer, chunkSize),
  ).toEqual({ finished: true });
  expect(
    new Headers(http.mock.calls[2]?.[1]?.headers).get("Content-Range"),
  ).toBe(`bytes 0-${chunkSize - 1}/${buffer.length}`);
});

it("reprend à la position confirmée et refuse une destination ou un accusé invalide", async () => {
  const file = {
    id: "object_1",
    kind: "progress",
    digest,
    size: bytes.length,
  } as const;
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(null, {
        headers: { Location: "https://example.test/transfer" },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { headers: { Location: path } }))
    .mockResolvedValueOnce(
      new Response(null, { status: 308, headers: { Range: "bytes=0-5" } }),
    )
    .mockResolvedValueOnce(
      new Response(null, { status: 308, headers: { Range: "bytes=0-99999" } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  const drive = createDriveTransport(http);
  await expect(drive.startUpload(authorization, file)).rejects.toThrow(
    /adresse/iu,
  );
  const transfer = await drive.startUpload(authorization, file);
  expect(await drive.probeUpload(authorization, transfer)).toEqual({
    nextOffset: 6,
  });
  await expect(
    drive.sendChunk(authorization, transfer, bytes, 6),
  ).rejects.toThrow(/position/iu);
  await expect(
    drive.probeUpload(authorization, transfer),
  ).rejects.toMatchObject({ status: 401 });
});
