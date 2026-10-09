// Markdown for agent replies (F-06). Output is sanitised: model text is untrusted.
import DOMPurify from "dompurify";
import { marked } from "marked";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
