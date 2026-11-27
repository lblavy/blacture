import { decodeEditionPackage } from "./edition-package";
import type { EditionValidation } from "./validate-edition";

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<Uint8Array<ArrayBuffer>>) => void;
  postMessage(message: EditionValidation): void;
};

worker.onmessage = ({ data }) => {
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(data);
    worker.postMessage({ edition: decodeEditionPackage(json) });
  } catch {
    worker.postMessage({});
  }
};
