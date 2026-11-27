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
const edition = {
  id: "object_1",
  kind: "edition",
  digest,
  size: bytes.length,
  editionHash: "a".repeat(64),
  predecessorHash: "b".repeat(64),
} as const;

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
  expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc,name");
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

it("demande au plus 16 Kio et accepte le préfixe d’une édition avec une plage exacte", async () => {
  const size = 20_000;
  const prefix = new Uint8Array(16 * 1024).fill(0x61);
  prefix[prefix.length - 1] = 0xc3;
  const http = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response(prefix, {
      status: 206,
      headers: { "Content-Range": `bytes 0-16383/${size}` },
    }),
  );
  const drive = createDriveTransport(http);
  expect(
    await drive.readEditionHeader(authorization, { ...edition, size }),
  ).toBe("a".repeat(16_383));
  expect(http.mock.calls[0]?.[0]).toBe(
    "https://www.googleapis.com/drive/v3/files/object_1?alt=media",
  );
  expect(new Headers(http.mock.calls[0]?.[1]?.headers).get("Range")).toBe(
    "bytes=0-16383",
  );
  expect(
    new Headers(http.mock.calls[0]?.[1]?.headers).get("Authorization"),
  ).toBe("Bearer test-token");
});

it("refuse une plage incohérente et annule un transfert d’édition volumineux qui ignore Range", async () => {
  const size = 20_000;
  const cancelFull = vi.fn();
  const cancelRange = vi.fn();
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: cancelFull })),
    )
    .mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: cancelRange }), {
        status: 206,
        headers: { "Content-Range": `bytes 1-16384/${size}` },
      }),
    );
  const drive = createDriveTransport(http);
  const largeEdition = { ...edition, size };
  await expect(
    drive.readEditionHeader(authorization, largeEdition),
  ).resolves.toBeUndefined();
  expect(cancelFull).toHaveBeenCalledOnce();
  await expect(
    drive.readEditionHeader(authorization, largeEdition),
  ).resolves.toBeUndefined();
  expect(cancelRange).toHaveBeenCalledOnce();
});

it("contrôle l’empreinte lorsque l’édition reçue est complète", async () => {
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(bytes))
    .mockResolvedValueOnce(
      new Response(bytes, {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
        },
      }),
    )
    .mockResolvedValueOnce(new Response(new Uint8Array(bytes.length)));
  const drive = createDriveTransport(http);
  for (let attempt = 0; attempt < 2; attempt++)
    expect(await drive.readEditionHeader(authorization, edition)).toBe(
      "Données fictives.",
    );
  expect(new Headers(http.mock.calls[0]?.[1]?.headers).has("Range")).toBe(
    false,
  );
  await expect(drive.readEditionHeader(authorization, edition)).rejects.toThrow(
    /empreinte/u,
  );
  await expect(
    drive.readEditionHeader(authorization, { ...edition, kind: "progress" }),
  ).resolves.toBeUndefined();
  expect(http).toHaveBeenCalledTimes(3);
});

it("refuse une lignée sur une ressource ou une édition qui se remplace elle-même", async () => {
  const drive = createDriveTransport(vi.fn<typeof fetch>());
  await expect(
    drive.startUpload(authorization, { ...edition, kind: "resource" }),
  ).rejects.toThrow(/précédente/u);
  await expect(
    drive.startUpload(authorization, {
      ...edition,
      predecessorHash: edition.editionHash,
    }),
  ).rejects.toThrow(/précédente/u);
});

it("transmet la lignée de la révision et contrôle les métadonnées finales", async () => {
  const sourceHash = "c".repeat(64);
  const revision = { ...edition, sourceHash };
  const remote = metadata(edition.id, edition.digest, edition.size, "edition");
  const appProperties = {
    ...remote.appProperties,
    edition: edition.editionHash,
    predecessor: edition.predecessorHash,
    source: sourceHash,
  };
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...remote, appProperties }))
    .mockResolvedValueOnce(new Response(null, { headers: { Location: path } }))
    .mockResolvedValueOnce(
      Response.json({
        ...remote,
        appProperties: { ...appProperties, predecessor: undefined },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ...remote,
        appProperties: { ...appProperties, source: "d".repeat(64) },
      }),
    )
    .mockResolvedValueOnce(Response.json({ ...remote, appProperties }));
  const drive = createDriveTransport(http);
  expect(await drive.metadata(authorization, edition.id)).toEqual(revision);
  const transfer = await drive.startUpload(authorization, revision);
  expect(
    JSON.parse(String(http.mock.calls[1]?.[1]?.body)).appProperties,
  ).toEqual(appProperties);
  await expect(
    drive.sendChunk(authorization, transfer, bytes, 0),
  ).rejects.toThrow(/incohérente/u);
  await expect(drive.probeUpload(authorization, transfer)).rejects.toThrow(
    /incohérente/u,
  );
  expect(await drive.probeUpload(authorization, transfer)).toEqual({
    finished: true,
  });
});

it("accepte une source seule sur une édition et refuse une source mal formée ou sur une ressource", async () => {
  const remote = metadata(edition.id, edition.digest, edition.size, "edition");
  const appProperties = {
    ...remote.appProperties,
    edition: edition.editionHash,
    source: "c".repeat(64),
  };
  const http = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ ...remote, appProperties }))
    .mockResolvedValueOnce(
      Response.json({
        ...remote,
        appProperties: { ...appProperties, source: "invalide" },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        ...remote,
        appProperties: { ...appProperties, kind: "resource" },
      }),
    );
  const drive = createDriveTransport(http);
  const parsed = await drive.metadata(authorization, edition.id);
  expect(parsed.sourceHash).toBe(appProperties.source);
  expect(parsed.predecessorHash).toBeUndefined();
  await expect(drive.metadata(authorization, edition.id)).rejects.toThrow(
    /invalide/u,
  );
  await expect(drive.metadata(authorization, edition.id)).rejects.toThrow(
    /invalide/u,
  );
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
