import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

// Task text comes from Slack, email and meetings: untrusted. Render Markdown, then sanitise; no
// images (tracking pixels), forms or styles. Links open in a new tab without a referrer.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") ?? "";
    if (href.startsWith("#/")) return; // a task reference inside the board
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** "PEN-12" in text → a link that opens that task on the board. */
export function linkTasks(md: string, prefix: string): string {
  if (!prefix) return md;
  const re = new RegExp(`(^|[^\\w\\[/#-])(${prefix}-\\d+)\\b(?!\\])`, "g");
  return md.replace(re, (_m, pre: string, ref: string) => `${pre}[${ref}](#/t/${ref})`);
}

export function renderMarkdown(md: string, prefix: string): string {
  const html = marked.parse(linkTasks(md, prefix), { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style", "form", "input", "button", "iframe", "video", "audio", "svg"], FORBID_ATTR: ["style"] });
}

export function Markdown({ text, prefix, className = "" }: { text: string; prefix: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text, prefix), [text, prefix]);
  if (!text.trim()) return null;
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
