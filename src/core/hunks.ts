// Line hunks between a file's current text and an agent's proposed text, so edits can be
// accepted or rejected per hunk (F-09).
import { diffLines } from "diff";

export interface Hunk {
  index: number;
  /** 0-based first line of the hunk in the original text (insertion point when oldLines = 0). */
  oldStart: number;
  oldLines: number;
  /** 0-based first line of the hunk in the proposed text. */
  newStart: number;
  newLines: number;
}

type Segment = { kind: "same"; text: string } | { kind: "hunk"; hunk: Hunk; removed: string; added: string };

export interface HunkDiff {
  hunks: Hunk[];
  segments: Segment[];
}

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export function computeHunks(oldText: string, newText: string): HunkDiff {
  const parts = diffLines(oldText, newText);
  const segments: Segment[] = [];
  const hunks: Hunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let open: { hunk: Hunk; removed: string; added: string } | undefined;

  const closeHunk = () => {
    if (!open) return;
    segments.push({ kind: "hunk", ...open });
    open = undefined;
  };

  for (const part of parts) {
    const lines = part.count ?? countLines(part.value);
    if (!part.added && !part.removed) {
      closeHunk();
      segments.push({ kind: "same", text: part.value });
      oldLine += lines;
      newLine += lines;
      continue;
    }
    if (!open) {
      const hunk: Hunk = { index: hunks.length, oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0 };
      hunks.push(hunk);
      open = { hunk, removed: "", added: "" };
    }
    if (part.removed) {
      open.removed += part.value;
      open.hunk.oldLines += lines;
      oldLine += lines;
    } else {
      open.added += part.value;
      open.hunk.newLines += lines;
      newLine += lines;
    }
  }
  closeHunk();
  return { hunks, segments };
}

/** Rebuilds the text keeping only the accepted hunks' changes. */
export function applyHunks(diff: HunkDiff, accepted: ReadonlySet<number>): string {
  let out = "";
  for (const seg of diff.segments) {
    if (seg.kind === "same") out += seg.text;
    else out += accepted.has(seg.hunk.index) ? seg.added : seg.removed;
  }
  return out;
}

export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(oldText, newText)) {
    const n = part.count ?? countLines(part.value);
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed };
}

/** Line-ending-insensitive equality: Hermes may write LF into a CRLF file or vice versa. */
export function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}
