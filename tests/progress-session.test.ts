import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createProgressSession } from "../src/reader/progress-session";
import * as storage from "../src/storage";
import type { ImportedBook } from "../src/import";

function controls() {
  const select = () => {
    const field = document.createElement("select");
    for (const value of ["auto", "read", "unread"])
      field.add(new Option(value, value));
    return field;
  };
  return {
    contents: document.createElement("article"),
    toolbar: document.createElement("header"),
    bookState: document.createElement("output"),
    sectionState: document.createElement("output"),
    bookMode: select(),
    sectionMode: select(),
    error: document.createElement("output"),
  };
}

async function edition(title: string) {
  const book: ImportedBook = {
    schemaVersion: 1,
    workId: title,
    editionId: "reading",
    title,
    sections: [
      {
        id: "first",
        parentId: null,
        title: "Lecture initiale",
        level: 1,
        fragmentIds: ["a"],
      },
      {
        id: "second",
        parentId: null,
        title: "Lecture suivante",
        level: 1,
        fragmentIds: ["b"],
      },
    ],
    fragments: [
      {
        id: "a",
        sectionId: "first",
        html: '<p data-block-id="a1">Premier chemin.</p>',
        blockIds: ["a1"],
        resourceIds: [],
      },
      {
        id: "b",
        sectionId: "second",
        html: '<p data-block-id="b1">Deuxième chemin.</p>',
        blockIds: ["b1"],
        resourceIds: [],
      },
    ],
    resources: [],
    destinations: {},
    diagnostics: [],
  };
  const entry = await storage.saveEdition(book);
  const manifest = (await storage.readManifest(entry.key))!;
  return { entry, manifest };
}

function changeMode(select: HTMLSelectElement, mode: string) {
  select.value = mode;
  select.dispatchEvent(new Event("change"));
}

it("keeps the latest block when resuming after a cancelled application update", async () => {
  const { entry, manifest } = await edition("Reprise après mise à jour");
  const view = controls();
  const session = createProgressSession(view, vi.fn());
  try {
    session.show({
      key: entry.key,
      manifest,
      section: "first",
      position: { fragmentId: "a" },
    });
    await vi.waitFor(() => expect(view.bookMode.disabled).toBe(false));
    await session.settled();
    const last = { fragmentId: "a", blockId: "a1" };
    await storage.updateProgress(entry.key, (state) => ({
      state: { ...state, last },
    }));
    const resume = session.suspend();
    resume();
    await session.settled();
    expect(await storage.readProgress(entry.key)).toMatchObject({ last });
  } finally {
    session.dispose();
  }
});

it("keeps forced choices and exact resume positions distinct in persisted state", async () => {
  const { entry, manifest } = await edition("Test reprise");
  const view = controls();
  const session = createProgressSession(view, vi.fn());
  try {
    await expect(session.resume(entry, "last")).rejects.toThrow(
      "Aucune consultation",
    );
    session.show({
      key: entry.key,
      manifest,
      section: "first",
      position: { fragmentId: "a" },
    });
    await vi.waitFor(() =>
      expect(view.bookState.textContent).toBe("Non commencé"),
    );
    await session.settled();
    changeMode(view.bookMode, "read");
    await session.settled();
    expect(view.bookState.textContent).toBe("Terminé");
    await expect(session.resume(entry, "progress")).rejects.toThrow(
      "Aucun passage",
    );
    changeMode(view.sectionMode, "unread");
    await session.settled();
    expect(view.bookState.textContent).toMatch(/^En cours/u);
    session.show({
      key: entry.key,
      manifest,
      section: "second",
      position: { fragmentId: "b", blockId: "b1" },
    });
    await session.settled();
    await expect(session.resume(entry, "last")).resolves.toEqual({
      fragmentId: "b",
      blockId: "b1",
    });
    await expect(session.resume(entry, "progress")).resolves.toEqual({
      fragmentId: "a",
      blockId: "a1",
    });
    expect(
      (await storage.listBooks()).find(({ key }) => key === entry.key)
        ?.progress,
    ).toMatchObject({
      status: "partial",
      hasLast: true,
    });
  } finally {
    session.dispose();
  }
});

it("preserves the last consultation if the reader is closed before preparation completes", async () => {
  const { entry, manifest } = await edition("Test index interrompu");
  const view = controls();
  const indexRead = vi
    .spyOn(storage, "readReadingIndex")
    .mockImplementationOnce(
      (_key, _manifest, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
  const session = createProgressSession(view, vi.fn());
  try {
    session.show({
      key: entry.key,
      manifest,
      section: "first",
      position: { fragmentId: "a", blockId: "a1" },
    });
    session.close();
    await session.settled();
    expect(view.bookMode.disabled).toBe(true);
    expect(indexRead.mock.calls[0]?.[2]?.aborted).toBe(true);
    await expect(session.resume(entry, "last")).resolves.toEqual({
      fragmentId: "a",
      blockId: "a1",
    });
    expect(
      (await storage.listBooks()).find(({ key }) => key === entry.key)?.progress
        ?.hasLast,
    ).toBe(true);
  } finally {
    session.dispose();
    indexRead.mockRestore();
  }
});
