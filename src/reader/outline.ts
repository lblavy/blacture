import type { ImportedSection } from "../import";

interface Branch {
  disclosure: HTMLDetailsElement;
  fill: () => void;
}

export function createOutline(
  container: HTMLElement,
  panel: HTMLDetailsElement,
  goTo: (fragment: string) => void,
) {
  const children = new Map<string | null, ImportedSection[]>();
  const byId = new Map<string, ImportedSection>();
  const buttons = new Map<string, HTMLButtonElement>();
  const branches = new Map<string, Branch>();
  let current: string | undefined;

  function show(sections: ImportedSection[]) {
    children.clear();
    byId.clear();
    buttons.clear();
    branches.clear();
    current = undefined;
    for (const section of sections) addSection(section);
    container.replaceChildren(renderList(children.get(null) ?? []));
  }

  function addSection(section: ImportedSection) {
    byId.set(section.id, section);
    const group = children.get(section.parentId) ?? [];
    group.push(section);
    children.set(section.parentId, group);
  }

  function renderList(sections: ImportedSection[]) {
    const list = document.createElement("ul");
    for (const section of sections) list.append(renderSection(section));
    return list;
  }

  function renderSection(section: ImportedSection) {
    const item = document.createElement("li");
    const title = section.title || "Section sans titre";
    const fragment = section.fragmentIds[0];
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.disabled = !fragment;
    if (fragment) button.addEventListener("click", () => goTo(fragment));
    if (section.id === current) button.setAttribute("aria-current", "location");
    buttons.set(section.id, button);
    item.append(button);
    const subsections = children.get(section.id);
    if (subsections?.length)
      item.append(makeBranch(section.id, title, subsections));
    return item;
  }

  function makeBranch(
    id: string,
    title: string,
    subsections: ImportedSection[],
  ) {
    const disclosure = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Sous-sections";
    summary.setAttribute("aria-label", `Sous-sections de ${title}`);
    disclosure.append(summary);
    let rendered = false;
    function fill() {
      if (rendered) return;
      rendered = true;
      disclosure.append(renderList(subsections));
    }
    disclosure.addEventListener("toggle", () => {
      if (disclosure.open) fill();
    });
    branches.set(id, { disclosure, fill });
    return disclosure;
  }

  function revealCurrent() {
    if (!current || !panel.open) return;
    const ancestors = new Set<string>();
    for (
      let id = byId.get(current)?.parentId;
      id && !ancestors.has(id);
      id = byId.get(id)?.parentId
    )
      ancestors.add(id);
    for (const id of Array.from(ancestors).reverse()) {
      const branch = branches.get(id);
      if (branch) {
        branch.disclosure.open = true;
        branch.fill();
      }
    }
  }

  panel.addEventListener("toggle", revealCurrent);
  function select(id: string) {
    if (current) buttons.get(current)?.removeAttribute("aria-current");
    current = id;
    revealCurrent();
    buttons.get(id)?.setAttribute("aria-current", "location");
  }

  return { show, select };
}
