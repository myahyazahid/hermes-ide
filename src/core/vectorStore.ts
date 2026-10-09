// Local vector store for the codebase index (F-18): a flat file of float32 vectors plus JSON
// metadata. Brute-force dot products stay well under 50 ms for tens of thousands of chunks, and
// there is no native dependency to ship in the VSIX.

export interface StoredChunk {
  path: string;
  startLine: number;
  endLine: number;
  /** Kept so search results can be shown and attached without re-reading the file. */
  text: string;
}

export interface FileEntry {
  /** size + mtime fingerprint; changes trigger re-embedding. */
  fingerprint: string;
  chunks: number;
}

export interface SearchHit extends StoredChunk {
  score: number;
}

interface Meta {
  version: 1;
  model: string;
  dims: number;
  files: Record<string, FileEntry>;
  chunks: StoredChunk[];
}

export class VectorStore {
  private chunks: StoredChunk[] = [];
  private vectors: Float32Array[] = [];
  private files = new Map<string, FileEntry>();
  dims = 0;

  constructor(public model: string) {}

  get size(): number {
    return this.chunks.length;
  }

  get fileCount(): number {
    return this.files.size;
  }

  fingerprint(path: string): string | undefined {
    return this.files.get(path)?.fingerprint;
  }

  paths(): string[] {
    return [...this.files.keys()];
  }

  /** Replaces everything stored for one file. */
  setFile(path: string, fingerprint: string, chunks: Omit<StoredChunk, "path">[], vectors: Float32Array[]): void {
    if (chunks.length !== vectors.length) throw new Error("chunks/vectors length mismatch");
    for (const v of vectors) {
      if (!this.dims) this.dims = v.length;
      if (v.length !== this.dims) throw new Error(`embedding size changed (${this.dims} → ${v.length}); rebuild the index`);
    }
    this.removeFile(path);
    for (let i = 0; i < chunks.length; i++) {
      this.chunks.push({ path, ...chunks[i] });
      this.vectors.push(vectors[i]);
    }
    this.files.set(path, { fingerprint, chunks: chunks.length });
  }

  removeFile(path: string): void {
    if (!this.files.delete(path)) return;
    const keep: number[] = [];
    this.chunks.forEach((c, i) => {
      if (c.path !== path) keep.push(i);
    });
    this.chunks = keep.map((i) => this.chunks[i]);
    this.vectors = keep.map((i) => this.vectors[i]);
  }

  /** Top-k by cosine similarity (vectors are unit length), at most `perFile` hits per file. */
  search(query: Float32Array, k = 8, perFile = 3): SearchHit[] {
    if (!this.dims || query.length !== this.dims) return [];
    const scored = this.vectors.map((v, i) => {
      let dot = 0;
      for (let d = 0; d < v.length; d++) dot += v[d] * query[d];
      return { i, score: dot };
    });
    scored.sort((a, b) => b.score - a.score);
    const out: SearchHit[] = [];
    const perFileCount = new Map<string, number>();
    for (const { i, score } of scored) {
      const c = this.chunks[i];
      const n = perFileCount.get(c.path) ?? 0;
      if (n >= perFile) continue;
      perFileCount.set(c.path, n + 1);
      out.push({ ...c, score });
      if (out.length >= k) break;
    }
    return out;
  }

  serialize(): { meta: string; vectors: Buffer } {
    const meta: Meta = { version: 1, model: this.model, dims: this.dims, files: Object.fromEntries(this.files), chunks: this.chunks };
    const buf = Buffer.alloc(this.vectors.length * this.dims * 4);
    this.vectors.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, i * this.dims * 4));
    return { meta: JSON.stringify(meta), vectors: buf };
  }

  /** Returns undefined when the data is unusable or belongs to another embedding model. */
  static deserialize(metaJson: string, vectors: Buffer, model: string): VectorStore | undefined {
    try {
      const meta = JSON.parse(metaJson) as Meta;
      if (meta.version !== 1 || meta.model !== model) return undefined;
      if (vectors.length !== meta.chunks.length * meta.dims * 4) return undefined;
      const store = new VectorStore(model);
      store.dims = meta.dims;
      store.chunks = meta.chunks;
      store.files = new Map(Object.entries(meta.files));
      const copy = new Uint8Array(vectors).buffer; // aligned copy
      store.vectors = meta.chunks.map((_, i) => new Float32Array(copy, i * meta.dims * 4, meta.dims));
      return store;
    } catch {
      return undefined;
    }
  }
}
