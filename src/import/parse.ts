import type { Element, Properties, Root } from "hast";
import { toHtml } from "hast-util-to-html";
import type { Root as MarkdownRoot, Text as MarkdownText } from "mdast";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
  type Options as SanitizeSchema,
} from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { pandocContainers } from "./pandoc-containers";
import { elements, stringProperty } from "./tree";
import type { ReportDiagnostic } from "./types";

const activeTags = [
  "applet",
  "audio",
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "picture",
  "script",
  "source",
  "style",
  "svg",
  "template",
  "track",
  "video",
];

const editorialTags = [
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
];

const commonProperties = [
  "ariaDescribedBy",
  "ariaLabel",
  "ariaLabelledBy",
  "className",
  "dataRole",
  "dataSourceImage",
  "dataToc",
  "dir",
  "id",
  "lang",
  "title",
];

const editorialRoles = [
  "navigation",
  "doc-toc",
  "doc-endnotes",
  "doc-footnote",
  "doc-noteref",
  "doc-backlink",
];

const retainedProperties: Record<string, string[]> = {
  a: ["dataFootnoteBackref", "dataFootnoteRef", "href"],
  col: ["span"],
  colgroup: ["span"],
  details: ["open"],
  img: ["alt", "height", "src", "width"],
  li: ["value"],
  ol: ["reversed", "start", "type"],
  section: ["dataFootnotes"],
  td: ["align", "colSpan", "rowSpan"],
  th: ["align", "colSpan", "rowSpan", "scope"],
  time: ["dateTime"],
};

const articleSchema: SanitizeSchema = {
  tagNames: editorialTags,
  attributes: {
    ...retainedProperties,
    "*": [...commonProperties, ["role", ...editorialRoles]],
  },
  ancestors: {
    tbody: ["table"],
    td: ["table"],
    th: ["table"],
    thead: ["table"],
    tfoot: ["table"],
    tr: ["table"],
  },
  protocols: { href: ["http", "https", "mailto"], src: ["data"] },
  strip: activeTags,
  // All article IDs are replaced before serialization. Legacy anchor names are consumed here too.
  clobber: [],
};

const storedFragmentParser = unified().use(rehypeRaw).freeze();
const storedFragmentSanitizer = unified()
  .use(rehypeSanitize, {
    ...articleSchema,
    attributes: {
      ...articleSchema.attributes,
      "*": [...commonProperties, ["role", ...editorialRoles], "dataBlockId"],
      a: [
        "dataFootnoteBackref",
        "dataFootnoteRef",
        "dataTargetAnchor",
        "dataExternalUrl",
      ],
      img: ["alt", "height", "width", "dataResourceId"],
    },
  })
  .freeze();

const ignoredPreNewline = /(<pre(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>)\n/g;

export function validateStoredFragment(html: string): Root {
  const parsed = storedFragmentParser.runSync({
    type: "root",
    children: [{ type: "raw", value: html }],
  }) as Root;
  const sanitized = storedFragmentSanitizer.runSync(parsed) as Root;
  // Fragment parsing consumes the first line feed after a pre start tag.
  // Make only that normalization when checking the stored serialization.
  if (html.replace(ignoredPreNewline, "$1") !== toHtml(sanitized))
    throw new Error("Contenu HTML non autorisé dans le paquet d’édition.");
  return sanitized;
}

export function parseMarkdown(
  source: string,
  report: ReportDiagnostic,
  restore: (tree: Root) => void,
): Root {
  const parser = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(headingAttributes, source, report)
    .use(pandocContainers, source, report)
    .use(remarkRehype, {
      allowDangerousHtml: true,
      clobberPrefix: "md-",
      footnoteLabel: "Notes",
      footnoteBackLabel: "Retour à l’appel de note",
    })
    .use(rehypeRaw)
    .use(restoreCompactedText, restore)
    .use(prepareEditorialHtml, report)
    .use(rehypeSanitize, articleSchema);
  return parser.runSync(parser.parse(source)) as Root;
}

function restoreCompactedText(restore: (tree: Root) => void) {
  return restore;
}

const headingAttributeSuffix = /(?:^|\s)\{([#.][^{}\n]*)\}\s*$/;

function headingAttributes(source: string, report: ReportDiagnostic) {
  return (tree: MarkdownRoot) => {
    for (const node of tree.children) {
      if (node.type !== "heading") continue;
      const last = node.children.at(-1);
      if (last?.type !== "text") continue;
      const attributes = readHeadingSuffix(last, source);
      if (!attributes?.[1]) continue;
      node.data = {
        ...node.data,
        hProperties: parseAttributes(attributes[1], report),
      };
      last.value = last.value.slice(0, attributes.index).trimEnd();
    }
  };
}

function readHeadingSuffix(node: MarkdownText, source: string) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return null;
  if (!headingAttributeSuffix.test(source.slice(start, end))) return null;
  return headingAttributeSuffix.exec(node.value);
}

function parseAttributes(tokens: string, report: ReportDiagnostic): Properties {
  const properties: Properties = { className: [] };
  for (const token of tokens.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? []) {
    if (token.startsWith("#")) {
      properties.id = token.slice(1);
    } else if (token.startsWith(".")) {
      (properties.className as string[]).push(token.slice(1));
    } else {
      const metadata =
        /^(lang|dir|title)=(?:"([^"]*)"|'([^']*)'|([^\s]+))$/.exec(token);
      if (metadata?.[1])
        properties[metadata[1]] = metadata[2] ?? metadata[3] ?? metadata[4];
      else report("unsupported-heading-attribute", "warning");
    }
  }
  if ((properties.className as string[]).length === 0)
    delete properties.className;
  return properties;
}

function prepareEditorialHtml(report: ReportDiagnostic) {
  return (tree: Root) => {
    for (const element of elements(tree.children)) {
      if (!editorialTags.includes(element.tagName))
        report("unsupported-markup", "warning");
      if (activeTags.includes(element.tagName))
        report("unsafe-markup", "warning");
      if (element.tagName === "a" && !element.properties.id) {
        const legacyAnchor = stringProperty(element, "name");
        if (legacyAnchor) element.properties.id = legacyAnchor;
      }
      delete element.properties.name;
      preserveEditorialStyle(element, report);
      inspectProperties(element, report);
    }
  };
}

function preserveEditorialStyle(element: Element, report: ReportDiagnostic) {
  const style = stringProperty(element, "style");
  if (!style) return;
  const declarations = style
    .toLowerCase()
    .split(";")
    .map((value) => value.replace(/\s/g, ""))
    .filter(Boolean);
  delete element.properties.style;
  if (declarations.includes("font-variant:small-caps"))
    addClass(element, "editorial-small-caps");
  if (element.tagName === "img" && declarations.includes("height:1em"))
    addClass(element, "editorial-inline-image");
  if (declarations.some((value) => !supportedStyles.has(value)))
    report("presentation-simplified", "warning");
  if (declarations.some((value) => /(?:url|expression)\(/.test(value)))
    report("unsafe-markup", "warning");
}

const supportedStyles = new Set([
  "font-variant:small-caps",
  "height:1em",
  "height:auto",
  "max-width:100%",
  "vertical-align:baseline",
  "width:auto",
]);

function addClass(element: Element, name: string) {
  const existing = element.properties.className;
  element.properties.className = Array.isArray(existing)
    ? [...existing, name]
    : [name];
}

function inspectProperties(element: Element, report: ReportDiagnostic) {
  const allowed = Object.hasOwn(retainedProperties, element.tagName)
    ? retainedProperties[element.tagName]
    : [];
  for (const property of Object.keys(element.properties)) {
    if (commonProperties.includes(property) || allowed?.includes(property))
      continue;
    if (
      property === "role" &&
      editorialRoles.includes(stringProperty(element, "role") ?? "")
    )
      continue;
    report("unsupported-attribute", "warning");
    if (
      /^(?:on|dataBlockId$|dataResourceId$|dataTargetAnchor$|dataExternalUrl$)/i.test(
        property,
      )
    ) {
      report("unsafe-markup", "warning");
    }
  }
}
