import "./styles.css";
import { startImportScreen } from "./import-screen";
import { registerOfflineWorker } from "./worker-client";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Élément absent : ${id}`);
  return node as T;
}

startImportScreen({
  form: element<HTMLFormElement>("import-form"),
  file: element<HTMLInputElement>("markdown-file"),
  submit: element<HTMLButtonElement>("import-submit"),
  cancel: element<HTMLButtonElement>("import-cancel"),
  status: element("import-status"),
  diagnostics: element("import-diagnostics"),
  catalog: element("catalog"),
  preview: element("fragment-preview"),
});

if (import.meta.env.PROD) {
  void registerOfflineWorker(
    element("offline-status"),
    element<HTMLButtonElement>("update"),
  );
}
