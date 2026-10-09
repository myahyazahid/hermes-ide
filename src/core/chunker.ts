// Splits source files into overlapping line windows for embedding (F-18). Line-based keeps chunk
// boundaries stable between edits and maps search hits straight back to editor ranges.

export interface Chunk {
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

export const CHUNK_LINES = 60;
export const CHUNK_OVERLAP = 12;
export const CHUNK_MAX_CHARS = 2400;

const SKIP_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/i;
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|7z|rar|exe|dll|so|dylib|bin|woff2?|ttf|otf|mp3|mp4|wav|mov|sqlite|db|lock|map|min\.js|min\.css|vsix|jar|class|pyc)$/i;

/** Files worth indexing: text sources that are not lockfiles, build output or minified bundles. */
export function shouldIndex(relPath: string, size: number, maxBytes: number): boolean {
  return size > 0 && size <= maxBytes && !SKIP_NAMES.test(relPath) && !SKIP_EXT.test(relPath);
}

export function chunkText(text: string): Chunk[] {
  if (text.includes("\0")) return [];
  const lines = text.split(/\r?\n/);
  // Minified or generated files: very long lines carry no useful structure.
  if (lines.some((l) => l.length > 1000) && lines.length < 20) return [];
  const chunks: Chunk[] = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + CHUNK_LINES);
    let body = slice.join("\n");
    let end = start + slice.length;
    if (body.length > CHUNK_MAX_CHARS) {
      // Shrink to fit, keeping whole lines.
      let chars = 0;
      let count = 0;
      for (const l of slice) {
        if (count > 0 && chars + l.length + 1 > CHUNK_MAX_CHARS) break;
        chars += l.length + 1;
        count++;
      }
      body = slice.slice(0, count).join("\n").slice(0, CHUNK_MAX_CHARS);
      end = start + count;
    }
    if (body.trim()) chunks.push({ startLine: start + 1, endLine: end, text: body });
    if (start + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

/** What gets embedded: the path helps the model connect a chunk to the file it lives in. */
export function embeddingInput(relPath: string, chunk: Chunk): string {
  return `File: ${relPath} (lines ${chunk.startLine}-${chunk.endLine})\n${chunk.text}`;
}
