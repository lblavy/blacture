import type { ImportedBook } from "../src/import";
import { runImport, type ImportMessage } from "../src/import-job";
import { expect, it, vi } from "vitest";

function workerDouble() {
  const worker = {
    onmessage: vi.fn<(event: MessageEvent<ImportMessage>) => void>(),
    onerror: vi.fn<(event: Event) => void>(),
    onmessageerror: vi.fn<(event: Event) => void>(),
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  return { worker, create: () => worker as unknown as Worker };
}

it("returns the worker result, forwards progress and then disposes the worker", async () => {
  const { worker, create } = workerDouble();
  const file = new File(["# Texte"], "exemple.md");
  const onProgress = vi.fn();
  const completion = runImport(
    file,
    new AbortController().signal,
    onProgress,
    create,
  );
  const book = { title: "exemple" } as ImportedBook;
  worker.onmessage(
    new MessageEvent("message", { data: { type: "progress", stage: "parse" } }),
  );
  worker.onmessage(
    new MessageEvent("message", { data: { type: "result", book } }),
  );
  await expect(completion).resolves.toBe(book);
  expect(worker.postMessage).toHaveBeenCalledWith(file);
  expect(onProgress).toHaveBeenCalledWith("parse");
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("terminates an in-progress import and does not launch one if already cancelled", async () => {
  const { worker, create } = workerDouble();
  const makeWorker = vi.fn(create);
  const controller = new AbortController();
  const file = new File([], "exemple.md");
  const completion = runImport(file, controller.signal, vi.fn(), makeWorker);
  controller.abort();
  await expect(completion).rejects.toMatchObject({ name: "AbortError" });
  await expect(
    runImport(file, controller.signal, vi.fn(), makeWorker),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(makeWorker).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it.each(["worker", "message", "processing"] as const)(
  "rejects a %s failure and cleans up",
  async (kind) => {
    const { worker, create } = workerDouble();
    const completion = runImport(
      new File([], "exemple.md"),
      new AbortController().signal,
      vi.fn(),
      create,
    );
    if (kind === "worker")
      worker.onerror(new Event("error", { cancelable: true }));
    if (kind === "message") worker.onmessageerror(new Event("messageerror"));
    if (kind === "processing")
      worker.onmessage(
        new MessageEvent("message", { data: { type: "error" } }),
      );
    await expect(completion).rejects.toThrow("Markdown UTF-8");
    expect(worker.terminate).toHaveBeenCalledOnce();
  },
);

it("explains that the selected file must be Markdown", async () => {
  const { worker, create } = workerDouble();
  const completion = runImport(
    new File([], "exemple.html"),
    new AbortController().signal,
    vi.fn(),
    create,
  );
  worker.onmessage(
    new MessageEvent("message", { data: { type: "unsupported-file" } }),
  );
  await expect(completion).rejects.toThrow(".md ou .markdown");
});
