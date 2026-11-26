import { readFragment, readResources } from "./storage";

function showMissingImage(image: HTMLImageElement) {
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  message.textContent = image.alt
    ? `Image indisponible · ${image.alt}`
    : "Image indisponible.";
  image.replaceWith(message);
}

export function createFragmentRenderer(container: HTMLElement) {
  let pending: AbortController | undefined;
  const objectUrls = new Map<string, string>();

  function clear() {
    pending?.abort();
    pending = undefined;
    container.replaceChildren();
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  async function open(
    key: string,
    fragmentId: string | undefined,
    configure?: (fragment: DocumentFragment) => void,
  ) {
    clear();
    if (!fragmentId) return false;
    const request = new AbortController();
    pending = request;
    try {
      const fragment = await readFragment(key, fragmentId, request.signal);
      if (!fragment) throw new Error("Fragment introuvable.");
      const resources = fragment.resourceIds.length
        ? await readResources(key, fragment.resourceIds, request.signal)
        : [];
      if (request.signal.aborted) return false;
      for (const { id, mimeType, bytes } of resources) {
        objectUrls.set(
          id,
          URL.createObjectURL(new Blob([bytes], { type: mimeType })),
        );
      }
      const template = document.createElement("template");
      // IndexedDB holds sanitized HTML serialized by the importer and its own resource markers.
      template.innerHTML = fragment.html;
      attachImages(template.content, objectUrls);
      wrapTables(template.content);
      configure?.(template.content);
      container.replaceChildren(template.content);
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      clear();
      throw error;
    } finally {
      if (pending === request) pending = undefined;
    }
  }

  return { open, clear };
}

function attachImages(container: DocumentFragment, urls: Map<string, string>) {
  for (const image of container.querySelectorAll<HTMLImageElement>(
    "img[data-resource-id]",
  )) {
    const url = urls.get(image.dataset.resourceId!);
    if (url) {
      image.addEventListener("error", () => showMissingImage(image), {
        once: true,
      });
      image.src = url;
    } else {
      showMissingImage(image);
    }
  }
}

function wrapTables(container: DocumentFragment) {
  for (const table of container.querySelectorAll("table")) {
    const region = document.createElement("div");
    region.className = "reader-table";
    region.tabIndex = 0;
    region.setAttribute("role", "region");
    region.setAttribute("aria-label", table.caption?.textContent || "Tableau");
    table.replaceWith(region);
    region.append(table);
  }
}
