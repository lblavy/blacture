import {
  isFontSize,
  readFontSize,
  saveFontSize,
  type FontSize,
} from "../storage";

export function applyFontPreference(
  select: HTMLSelectElement,
  contents: HTMLElement,
  status: HTMLElement,
) {
  let revision = 0;
  let writing = Promise.resolve();
  let failedWrites = 0;
  function apply(size: FontSize) {
    select.value = size;
    contents.dataset.fontSize = size;
  }
  apply("medium");
  void readFontSize().then(
    (size) => {
      if (revision === 0) apply(size);
    },
    () => {
      if (revision === 0)
        status.textContent = "Impossible de relire la taille du texte.";
    },
  );
  select.addEventListener("change", () => {
    const size = select.value;
    if (!isFontSize(size)) return;
    const latest = ++revision;
    apply(size);
    writing = writing
      .then(() => saveFontSize(size))
      .catch(() => {
        failedWrites++;
        if (latest === revision)
          status.textContent = "Impossible d’enregistrer la taille du texte.";
      });
  });
  return async () => {
    const before = failedWrites;
    await writing;
    if (failedWrites !== before)
      throw new Error("L’enregistrement de la taille du texte a échoué.");
  };
}
