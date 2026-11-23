// Jira's API v3 carries issue descriptions and comments as ADF (Atlassian Document Format) JSON.
// These two functions are the only translation between ADF and the plain text the agents read and
// write: text in, text out, no formatting that Jira doesn't ask for.

export type AdfNode = {
  type: string;
  version?: number;
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
};

/** Plain text to an ADF document: blank-line-separated paragraphs, `- ` list items, single newlines as hardBreaks. */
export function adfFromText(text: string): AdfNode {
  const blocks: AdfNode[] = [];
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const para of paragraphs) {
    const lines = para.split("\n");
    if (lines.every((l) => l.trim().startsWith("- "))) {
      blocks.push({
        type: "bulletList",
        content: lines.map((l) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: inline(l.trim().slice(2)) }],
        })),
      });
    } else {
      blocks.push({ type: "paragraph", content: inline(lines.join("\n")) });
    }
  }
  return { type: "doc", version: 1, content: blocks.length ? blocks : [{ type: "paragraph", content: [] }] };
}

/** One paragraph's text, with newlines as hardBreaks. */
function inline(text: string): AdfNode[] {
  const parts = text.split("\n");
  const content: AdfNode[] = [];
  parts.forEach((part, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    if (part) content.push({ type: "text", text: part });
  });
  return content.length ? content : [{ type: "text", text: " " }];
}

/** ADF to plain text: headings, paragraphs and list items read back as text, hardBreaks as newlines. */
export function textFromAdf(doc: unknown): string {
  const out = render(doc as AdfNode);
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function render(node: AdfNode): string {
  switch (node.type) {
    case "doc":
    case "blockquote":
    case "listItem":
      return (node.content ?? []).map(render).join(node.type === "listItem" ? "" : "\n");
    case "paragraph":
    case "heading":
    case "codeBlock":
      return "\n" + renderChildren(node) + "\n";
    case "bulletList":
    case "orderedList":
      return (node.content ?? []).map((item) => "- " + render(item).trim()).join("\n");
    case "tableRow":
      return (node.content ?? []).map((cell) => render(cell).trim()).join(" | ");
    case "tableCell":
    case "tableHeader":
      return renderChildren(node);
    case "hardBreak":
      return "\n";
    case "text":
      return node.text ?? "";
    case "media":
      return node.attrs?.url ? String(node.attrs.url) : "(attachment)";
    default:
      return renderChildren(node);
  }
}

function renderChildren(node: AdfNode): string {
  return (node.content ?? []).map(render).join("");
}
