// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import type { ImportMessage } from "../src/import-job";

type WorkerScope = { onmessage: (event: { data: File }) => Promise<void> };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function processFile(file: File) {
  const send = vi.fn<(message: ImportMessage) => void>();
  vi.stubGlobal("postMessage", send);
  vi.stubGlobal("onmessage", undefined);
  await import("../src/import-worker");
  await (globalThis as unknown as WorkerScope).onmessage({ data: file });
  return send.mock.calls.map(([message]) => message);
}

it("decodes a UTF-8 file and replies with the book and its analysis stages", async () => {
  const messages = await processFile(
    new File(["# Un titre\n\n道"], "ouvrage.markdown"),
  );
  expect(messages.map(({ type }) => type)).toEqual([
    "progress",
    "progress",
    "progress",
    "result",
  ]);
  expect(messages.at(-1)).toMatchObject({
    type: "result",
    book: { title: "ouvrage", diagnostics: [] },
  });
});

it("responds with a safe error for invalid UTF-8", async () => {
  const messages = await processFile(
    new File([new Uint8Array([0xff, 0xfe])], "invalide.md"),
  );
  expect(messages).toEqual([{ type: "error" }]);
});

it("rejects an HTML file selected outside the Markdown picker filter", async () => {
  const messages = await processFile(
    new File(["<p>Un document</p>"], "document.html"),
  );
  expect(messages).toEqual([{ type: "unsupported-file" }]);
});
