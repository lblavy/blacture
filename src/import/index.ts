import { indexAnchors, rewriteReferences } from "./anchors";
import { assemble } from "./assemble";
import { compactImages } from "./compact-images";
import { sha256 } from "./identity";
import { outlineBlocks } from "./outline";
import { parseMarkdown } from "./parse";
import { extractResources } from "./resources";
import { visibleNodes } from "./tree";
import type {
  ImportedBook,
  ImportDiagnostic,
  ImportOptions,
  ImportStage,
  ReportDiagnostic,
} from "./types";

export type {
  ImportedBook,
  ImportedFragment,
  ImportedResource,
  ImportedSection,
  ImportDestination,
  ImportDiagnostic,
  ImportOptions,
  ImportStage,
} from "./types";

export async function importMarkdown(
  source: string,
  options: ImportOptions = {},
): Promise<ImportedBook> {
  const diagnostics = new Map<string, ImportDiagnostic>();
  const report: ReportDiagnostic = (code, severity) => {
    const previous = diagnostics.get(code);
    if (previous) previous.count += 1;
    else diagnostics.set(code, { code, severity, count: 1 });
  };
  announce(options, "parse");
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const editionId = await sha256(new TextEncoder().encode(normalized));
  options.signal?.throwIfAborted();
  const compacted = compactImages(normalized);
  const outline = outlineBlocks(
    visibleNodes(
      parseMarkdown(compacted.source, report, compacted.restoreEditorialText),
    ),
  );
  const nodes = outline.map(({ node }) => node);
  if (nodes.length === 0) report("empty-document", "error");

  announce(options, "resources");
  const resources = await extractResources(
    nodes,
    report,
    options.signal,
    compacted.imageUrl,
  );

  announce(options, "assemble");
  const headings = outline.flatMap(({ heading }) => heading ?? []);
  const anchors = indexAnchors(nodes, headings, report);
  rewriteReferences(nodes, anchors, report);
  const article = assemble(outline, anchors);
  const firstHeading = article.sections.find(({ level }) => level > 0);
  return {
    schemaVersion: 1,
    workId: options.workId ?? `work-${editionId}`,
    editionId,
    title: options.title?.trim() || firstHeading?.title || "Ouvrage sans titre",
    ...article,
    resources,
    diagnostics: [...diagnostics.values()],
  };
}

function announce(options: ImportOptions, stage: ImportStage) {
  options.signal?.throwIfAborted();
  options.onProgress?.(stage);
}
