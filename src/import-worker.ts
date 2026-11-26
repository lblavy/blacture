import { importMarkdown } from "./import";
import type { ImportMessage } from "./import-job";

const worker = globalThis as unknown as {
  onmessage: (event: MessageEvent<File>) => void;
  postMessage(message: ImportMessage, buffers?: Transferable[]): void;
};
const markdownExtension = /\.(?:md|markdown)$/i;

worker.onmessage = async ({ data: file }) => {
  if (!markdownExtension.test(file.name)) {
    worker.postMessage({ type: "unsupported-file" });
    return;
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      await file.arrayBuffer(),
    );
    const book = await importMarkdown(source, {
      title: file.name.replace(markdownExtension, ""),
      onProgress: (stage) => worker.postMessage({ type: "progress", stage }),
    });
    worker.postMessage(
      { type: "result", book },
      book.resources.map(({ bytes }) => bytes.buffer),
    );
  } catch {
    worker.postMessage({ type: "error" });
  }
};
