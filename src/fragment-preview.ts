import { readFragment, readResources, type CatalogEntry } from "./storage";

function showMissingImage(image: HTMLImageElement) {
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  message.textContent = image.alt
    ? `Image indisponible · ${image.alt}`
    : "Image indisponible.";
  image.replaceWith(message);
}

export function createFragmentPreview(container: HTMLElement) {
  let nextRequest = 0;
  let objectUrls: string[] = [];

  function clear() {
    container.replaceChildren();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  }

  async function open(entry: CatalogEntry) {
    const request = ++nextRequest;
    clear();
    if (!entry.firstFragmentId) return;
    const fragment = await readFragment(entry.key, entry.firstFragmentId);
    if (!fragment) throw new Error("Fragment introuvable.");
    const resources = await readResources(entry.key, fragment.resourceIds);
    if (request !== nextRequest) return;

    const urls = new Map(
      resources.map(({ id, mimeType, bytes }) => [
        id,
        URL.createObjectURL(new Blob([bytes], { type: mimeType })),
      ]),
    );
    objectUrls = [...urls.values()];
    const template = document.createElement("template");
    // The importer only serializes sanitized HTML and generates its own resource markers.
    template.innerHTML = fragment.html;
    for (const image of template.content.querySelectorAll<HTMLImageElement>(
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
    container.replaceChildren(template.content);
  }

  return { open, clear };
}
