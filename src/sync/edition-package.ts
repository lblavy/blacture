import { sha256 } from "../import/identity";
import { validateStoredFragment } from "../import/parse";
import {
  isRasterMime,
  maxImageBytes,
  validateRasterBytes,
} from "../import/raster";
import { elements, stringProperty } from "../import/tree";
import type {
  ImportDestination,
  ImportDiagnostic,
  ImportedBook,
  ImportedFragment,
  ImportedSection,
} from "../import/types";
import type { Manifest } from "../storage";

export interface EditionResourceDescriptor {
  id: string;
  mimeType: string;
  size: number;
}

export interface EditionPackage {
  schemaVersion: 1;
  manifest: Manifest;
  fragments: ImportedFragment[];
  resources: EditionResourceDescriptor[];
}

const maxPackageLength = 128 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const anchorPattern = /^blacture-anchor-[a-z0-9-]+$/;

function invalidPackage(): never {
  throw new Error("Paquet d’édition invalide.");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalidPackage();
  return value as Record<string, unknown>;
}

function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidPackage();
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") invalidPackage();
  return value;
}

function identifier(value: unknown): string {
  const id = text(value);
  if (!id || id.length > 2048) invalidPackage();
  return id;
}

function digest(value: unknown): string {
  const id = text(value);
  if (!digestPattern.test(id)) invalidPackage();
  return id;
}

function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalidPackage();
  return value;
}

function readSection(value: unknown): ImportedSection {
  const s = record(value);
  return {
    id: identifier(s.id),
    parentId: s.parentId === null ? null : identifier(s.parentId),
    title: text(s.title),
    level: integer(s.level, 0, 6),
    fragmentIds: items(s.fragmentIds).map(identifier),
  };
}

function readDestination(value: unknown): ImportDestination {
  const d = record(value);
  const elementId = identifier(d.elementId);
  if (!anchorPattern.test(elementId)) invalidPackage();
  return { fragmentId: identifier(d.fragmentId), elementId };
}

function readDiagnostic(value: unknown): ImportDiagnostic {
  const d = record(value);
  if (d.severity !== "warning") invalidPackage();
  return {
    code: identifier(d.code),
    severity: d.severity,
    count: integer(d.count, 1, Number.MAX_SAFE_INTEGER),
  };
}

function readManifest(value: unknown): Manifest {
  const m = record(value);
  if (m.schemaVersion !== 1) invalidPackage();
  return {
    schemaVersion: 1,
    workId: identifier(m.workId),
    editionId: digest(m.editionId),
    title: text(m.title),
    sections: items(m.sections).map(readSection),
    destinations: Object.fromEntries(
      Object.entries(record(m.destinations)).map(([name, destination]) => [
        identifier(name),
        readDestination(destination),
      ]),
    ),
    diagnostics: items(m.diagnostics).map(readDiagnostic),
  };
}

function readFragment(value: unknown): ImportedFragment {
  const f = record(value);
  return {
    id: identifier(f.id),
    sectionId: identifier(f.sectionId),
    html: text(f.html),
    blockIds: items(f.blockIds).map(identifier),
    resourceIds: items(f.resourceIds).map(digest),
  };
}

function readResource(value: unknown): EditionResourceDescriptor {
  const r = record(value);
  if (!isRasterMime(r.mimeType)) invalidPackage();
  return {
    id: digest(r.id),
    mimeType: r.mimeType,
    size: integer(r.size, 1, maxImageBytes),
  };
}

function checkPackageLength(json: string) {
  if (json.length > maxPackageLength)
    throw new Error("Le paquet d’édition est trop volumineux.");
}

export function encodeEditionPackage(book: ImportedBook): string {
  const { fragments, resources, ...manifest } = book;
  const canonicalManifest = readManifest(manifest);
  canonicalManifest.destinations = Object.fromEntries(
    Object.entries(canonicalManifest.destinations).sort(([a], [b]) =>
      compareKeys(a, b),
    ),
  );
  canonicalManifest.diagnostics.sort((a, b) => compareKeys(a.code, b.code));
  const pkg: EditionPackage = {
    schemaVersion: 1,
    manifest: canonicalManifest,
    fragments: fragments.map(readFragment),
    resources: resources
      .map(({ id, mimeType, bytes }) =>
        readResource({ id, mimeType, size: bytes.byteLength }),
      )
      .sort((a, b) => compareKeys(a.id, b.id)),
  };
  validateStructure(pkg.manifest.sections, pkg.fragments);
  validateResources(pkg.resources);
  const json = JSON.stringify(pkg);
  checkPackageLength(json);
  return json;
}

function compareKeys(first: string, second: string) {
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function validateStructure(
  sections: ImportedSection[],
  fragments: ImportedFragment[],
) {
  const levels = new Map<string, number>();
  const fragmentIds = new Set<string>();
  let next = 0;
  for (const section of sections) {
    registerSection(section, levels);
    for (const fragmentId of section.fragmentIds) {
      const fragment = fragments[next++];
      if (fragment?.id !== fragmentId || fragment.sectionId !== section.id)
        invalidPackage();
      addUnique(fragmentIds, fragmentId);
    }
  }
  if (next === 0 || next !== fragments.length) invalidPackage();
}

function registerSection(
  section: ImportedSection,
  levels: Map<string, number>,
) {
  if (levels.has(section.id)) invalidPackage();
  if (section.parentId !== null) {
    const parentLevel = levels.get(section.parentId);
    if (!parentLevel || parentLevel >= section.level) invalidPackage();
  }
  levels.set(section.id, section.level);
}

function validateResources(resources: EditionResourceDescriptor[]) {
  const ids = new Set<string>();
  let totalSize = 0;
  for (const resource of resources) {
    if (ids.has(resource.id)) invalidPackage();
    ids.add(resource.id);
    totalSize += resource.size;
  }
  if (totalSize > maxPackageLength)
    throw new Error(
      "Les ressources du paquet d’édition sont trop volumineuses.",
    );
  return ids;
}

function validateExternalLink(value: string) {
  if (!URL.canParse(value)) invalidPackage();
  const url = new URL(value);
  if (
    !["https:", "http:", "mailto:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    invalidPackage();
}

interface FragmentValidation {
  readonly blocks: Set<string>;
  readonly anchors: Map<string, string>;
  readonly resources: Set<string>;
  readonly targets: Set<string>;
}

function addUnique(items: Set<string>, id: string) {
  if (items.has(id)) invalidPackage();
  items.add(id);
}

function validateBlocks(
  root: ReturnType<typeof validateStoredFragment>,
  fragment: ImportedFragment,
  blocks: Set<string>,
) {
  const ids: string[] = [];
  for (const child of root.children) {
    if (child.type === "text" && !child.value.trim()) continue;
    if (child.type !== "element") invalidPackage();
    const blockId = identifier(child.properties.dataBlockId);
    addUnique(blocks, blockId);
    ids.push(blockId);
  }
  if (!ids.length || !sameValues(ids, fragment.blockIds)) invalidPackage();
}

function sameValues(values: string[], expected: string[]) {
  return (
    values.length === expected.length &&
    values.every((value, i) => value === expected[i])
  );
}

function validateFragment(
  fragment: ImportedFragment,
  validation: FragmentValidation,
) {
  const root = validateStoredFragment(fragment.html);
  validateBlocks(root, fragment, validation.blocks);
  const images = new Set<string>();
  const topLevel = new Set(root.children);
  for (const element of elements(root.children)) {
    if (
      Object.hasOwn(element.properties, "dataBlockId") &&
      !topLevel.has(element)
    )
      invalidPackage();
    if (Object.hasOwn(element.properties, "id")) {
      const id = identifier(element.properties.id);
      if (!anchorPattern.test(id) || validation.anchors.has(id))
        invalidPackage();
      validation.anchors.set(id, fragment.id);
    }
    if (element.tagName === "img") {
      const resourceId = digest(element.properties.dataResourceId);
      images.add(resourceId);
      validation.resources.add(resourceId);
    }
    validateLinkMarkers(element, validation.targets);
  }
  if (!sameValues([...images], fragment.resourceIds)) invalidPackage();
}

function validateLinkMarkers(
  element: Parameters<typeof stringProperty>[0],
  targets: Set<string>,
) {
  const external = stringProperty(element, "dataExternalUrl");
  const target = stringProperty(element, "dataTargetAnchor");
  if (external && target) invalidPackage();
  if (external) validateExternalLink(external);
  if (target) targets.add(identifier(target));
}

function validateReferences(
  manifest: Manifest,
  resources: Set<string>,
  actual: FragmentValidation,
) {
  const declared = new Set<string>();
  for (const { elementId, fragmentId } of Object.values(
    manifest.destinations,
  )) {
    if (actual.anchors.get(elementId) !== fragmentId) invalidPackage();
    addUnique(declared, elementId);
  }
  if (declared.size !== actual.anchors.size) invalidPackage();
  for (const target of actual.targets)
    if (!Object.hasOwn(manifest.destinations, target)) invalidPackage();
  if (actual.resources.size !== resources.size) invalidPackage();
  for (const resource of actual.resources)
    if (!resources.has(resource)) invalidPackage();
}

function parsePackage(json: string) {
  checkPackageLength(json);
  try {
    return record(JSON.parse(json) as unknown);
  } catch {
    return invalidPackage();
  }
}

export function decodeEditionPackage(
  json: string,
  expectedKey?: string,
): EditionPackage {
  const data = parsePackage(json);
  if (data.schemaVersion !== 1) invalidPackage();
  const manifest = readManifest(data.manifest);
  if (
    expectedKey !== undefined &&
    JSON.stringify([manifest.workId, manifest.editionId]) !== expectedKey
  )
    throw new Error(
      "L’identité du paquet d’édition diffère de l’édition attendue.",
    );
  const resources = items(data.resources).map(readResource);
  const resourceIds = validateResources(resources);
  const fragments = items(data.fragments).map(readFragment);
  validateStructure(manifest.sections, fragments);
  const validation: FragmentValidation = {
    blocks: new Set(),
    anchors: new Map(),
    resources: new Set(),
    targets: new Set(),
  };
  for (const fragment of fragments) validateFragment(fragment, validation);
  validateReferences(manifest, resourceIds, validation);
  return { schemaVersion: 1, manifest, fragments, resources };
}

export async function assembleEditionPackage(
  pkg: EditionPackage,
  load: (
    descriptor: EditionResourceDescriptor,
  ) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<ImportedBook> {
  const resources: ImportedBook["resources"] = [];
  for (const descriptor of pkg.resources) {
    const { id, mimeType, size } = descriptor;
    const bytes = await load(descriptor);
    if (bytes.byteLength !== size)
      throw new Error("Taille de ressource d’édition invalide.");
    if ((await sha256(bytes)) !== id)
      throw new Error("Empreinte de ressource d’édition invalide.");
    if (!isRasterMime(mimeType) || !validateRasterBytes(mimeType, bytes))
      throw new Error("Image du paquet d’édition invalide.");
    resources.push({ id, mimeType, bytes });
  }
  return { ...pkg.manifest, fragments: pkg.fragments, resources };
}
