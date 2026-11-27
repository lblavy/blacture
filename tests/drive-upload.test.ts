// @vitest-environment node
import { expect, it, vi } from "vitest";
import { sha256 } from "../src/import/identity";
import { DriveHttpError, type DriveFile } from "../src/sync/drive-transport";
import {
  uploadDriveObject,
  type TransferTicket,
} from "../src/sync/drive-upload";

const auth = { token: "fictif" };
const bytes = new TextEncoder().encode("Une donnée de lecture synthétique");
const file: DriveFile = {
  id: "reserved_id",
  kind: "progress",
  digest: await sha256(bytes),
  size: bytes.length,
};
const source = { kind: file.kind, bytes };
const location =
  "https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture";

function fixture(initial?: TransferTicket) {
  let ticket = initial;
  const store = {
    read: vi.fn(async () => ticket),
    write: vi.fn(async (_key: string, value: TransferTicket) => {
      ticket = value;
    }),
  };
  const drive = {
    reserveId: vi.fn().mockResolvedValue(file.id),
    startUpload: vi.fn().mockResolvedValue({ file, location }),
    probeUpload: vi.fn().mockResolvedValue({ nextOffset: 4 }),
    sendChunk: vi.fn().mockResolvedValue({ finished: true }),
    metadata: vi.fn().mockResolvedValue(file),
    download: vi.fn().mockResolvedValue(bytes),
  };
  return { drive, store };
}

it("conserve l’identifiant après expiration et reprend depuis les octets confirmés", async () => {
  const { drive, store } = fixture();
  drive.sendChunk.mockRejectedValueOnce(new DriveHttpError(401));
  await expect(
    uploadDriveObject(auth, source, store, drive),
  ).rejects.toMatchObject({ status: 401 });
  expect(store.write.mock.calls.map(([, ticket]) => ticket)).toEqual([
    { id: file.id, finished: false },
    { id: file.id, location, finished: false },
  ]);
  expect(await uploadDriveObject(auth, source, store, drive)).toEqual(file);
  expect(drive.reserveId).toHaveBeenCalledOnce();
  expect(drive.startUpload).toHaveBeenCalledOnce();
  expect(drive.sendChunk).toHaveBeenLastCalledWith(
    auth,
    { file, location },
    bytes,
    4,
  );
  expect(store.write).toHaveBeenLastCalledWith(`progress:${file.digest}`, {
    id: file.id,
    finished: true,
  });
});

it("réutilise l’identifiant après expiration d’une session et vérifie un fichier déjà créé", async () => {
  const { drive, store } = fixture({ id: file.id, location, finished: false });
  drive.probeUpload.mockRejectedValueOnce(new DriveHttpError(404));
  drive.startUpload.mockRejectedValueOnce(new DriveHttpError(409));
  expect(await uploadDriveObject(auth, source, store, drive)).toEqual(file);
  expect(drive.reserveId).not.toHaveBeenCalled();
  expect(drive.metadata).toHaveBeenCalledWith(auth, file.id);
  expect(drive.download).toHaveBeenCalledWith(auth, file);
  expect(drive.sendChunk).not.toHaveBeenCalled();
});

it("refuse une collision d’identifiant dont les métadonnées ne concordent pas", async () => {
  const { drive, store } = fixture({ id: file.id, finished: false });
  drive.startUpload.mockRejectedValueOnce(new DriveHttpError(409));
  drive.metadata.mockResolvedValueOnce({ ...file, digest: "0".repeat(64) });
  await expect(uploadDriveObject(auth, source, store, drive)).rejects.toThrow(
    /incompatible/u,
  );
  expect(drive.download).not.toHaveBeenCalled();
  expect(store.write).not.toHaveBeenCalled();
});

it("ne restaure pas silencieusement un fichier confirmé puis supprimé sur Drive", async () => {
  const { drive, store } = fixture({ id: file.id, finished: true });
  drive.metadata.mockRejectedValueOnce(new DriveHttpError(404));
  await expect(
    uploadDriveObject(auth, source, store, drive),
  ).rejects.toMatchObject({ status: 404 });
  expect(drive.startUpload).not.toHaveBeenCalled();
  expect(store.write).not.toHaveBeenCalled();
});

it.each(["predecessorHash", "sourceHash"] as const)(
  "refuse le fichier confirmé si %s diffère",
  async (property) => {
    const { drive, store } = fixture({ id: file.id, finished: true });
    const edition = { kind: "edition", editionHash: "a".repeat(64) } as const;
    drive.metadata.mockResolvedValueOnce({
      ...file,
      ...edition,
      [property]: "b".repeat(64),
    });
    await expect(
      uploadDriveObject(
        auth,
        {
          ...edition,
          bytes,
          [property]: "c".repeat(64),
        },
        store,
        drive,
      ),
    ).rejects.toThrow(/incompatible/u);
    expect(drive.download).not.toHaveBeenCalled();
  },
);

it("réutilise une révision déjà publiée avant l’ajout de la métadonnée de lignée", async () => {
  const { drive, store } = fixture({ id: file.id, finished: true });
  const edition = { kind: "edition", editionHash: "a".repeat(64) } as const;
  const remote = { ...file, ...edition };
  const predecessorHash = "b".repeat(64);
  drive.metadata.mockResolvedValueOnce(remote);
  await expect(
    uploadDriveObject(
      auth,
      { ...edition, bytes, predecessorHash },
      store,
      drive,
    ),
  ).resolves.toEqual({ ...remote, predecessorHash });
  expect(drive.download).toHaveBeenCalledWith(auth, remote);
  expect(drive.startUpload).not.toHaveBeenCalled();
  expect(store.write).not.toHaveBeenCalled();
});
