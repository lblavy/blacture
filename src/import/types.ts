export type ImportStage = "parse" | "resources" | "assemble";

export interface ImportOptions {
  workId?: string;
  title?: string;
  signal?: AbortSignal;
  onProgress?: (stage: ImportStage) => void;
}

export interface ImportDiagnostic {
  code: string;
  severity: "warning" | "error";
  count: number;
}

export interface ImportDestination {
  fragmentId: string;
  elementId: string;
}

export interface ImportedSection {
  id: string;
  parentId: string | null;
  title: string;
  level: number;
  fragmentIds: string[];
}

export interface ImportedFragment {
  id: string;
  sectionId: string;
  html: string;
  blockIds: string[];
  resourceIds: string[];
}

export interface ImportedResource {
  id: string;
  mimeType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export interface ImportedBook {
  schemaVersion: 1;
  workId: string;
  editionId: string;
  sourceEditionId?: string;
  replacesEditionId?: string;
  title: string;
  sections: ImportedSection[];
  fragments: ImportedFragment[];
  destinations: Record<string, ImportDestination>;
  resources: ImportedResource[];
  diagnostics: ImportDiagnostic[];
}

export type ReportDiagnostic = (
  code: string,
  severity: ImportDiagnostic["severity"],
) => void;
