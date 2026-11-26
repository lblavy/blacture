import type { ImportedBook, ImportStage } from "./import";

export type ImportMessage =
  | { type: "progress"; stage: ImportStage }
  | { type: "result"; book: ImportedBook }
  | { type: "error" | "unsupported-file" };

function createWorker() {
  return new Worker(new URL("./import-worker.ts", import.meta.url), {
    type: "module",
  });
}

export async function runImport(
  file: File,
  signal: AbortSignal,
  onProgress: (stage: ImportStage) => void,
  makeWorker = createWorker,
): Promise<ImportedBook> {
  signal.throwIfAborted();
  const worker = makeWorker();
  const importError = new Error(
    "Impossible de lire le Markdown UTF-8 ou de terminer son analyse.",
  );
  let abort: (() => void) | undefined;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = (event) => {
        event.preventDefault();
        reject(importError);
      };
      worker.onmessageerror = () => reject(importError);
      worker.onmessage = ({ data }: MessageEvent<ImportMessage>) => {
        switch (data.type) {
          case "progress":
            onProgress(data.stage);
            break;
          case "result":
            resolve(data.book);
            break;
          case "error":
            reject(importError);
            break;
          case "unsupported-file":
            reject(
              new Error("Sélectionne un fichier Markdown (.md ou .markdown)."),
            );
            break;
        }
      };
      worker.postMessage(file);
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}
