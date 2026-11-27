import { decodeEditionPackage, type EditionPackage } from "./edition-package";

export interface EditionValidation {
  edition?: EditionPackage;
}

export async function validateDriveEdition(
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<EditionPackage> {
  signal?.throwIfAborted();
  if (typeof Worker === "undefined")
    return decodeEditionPackage(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./edition-worker.ts", import.meta.url), {
      type: "module",
    });
    function cleanup() {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    }
    function abort() {
      cleanup();
      reject(signal?.reason);
    }
    function invalid() {
      cleanup();
      reject(new Error("Paquet d’édition Drive invalide."));
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = invalid;
    worker.onmessageerror = invalid;
    worker.onmessage = ({ data }: MessageEvent<EditionValidation>) => {
      if (!data.edition) return invalid();
      cleanup();
      resolve(data.edition);
    };
    try {
      worker.postMessage(bytes, [bytes.buffer]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
