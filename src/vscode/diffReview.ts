// Diff review for agent edits (F-09). Hermes asks permission *before* writing, sending the old and
// proposed text; we show them in a diff editor with CodeLens to accept/reject the edit and toggle
// individual hunks. Ctrl+Enter / Ctrl+Backspace act on the focused review.
import * as path from "node:path";
import * as vscode from "vscode";
import { computeHunks, type HunkDiff } from "../core/hunks";
import { t, type Locale } from "../shared/strings";

export const DIFF_SCHEME = "hermes-diff";
const CONTEXT_KEY = "hermes.diffReviewActive";

export interface ReviewRequest {
  id: string;
  path: string;
  oldText: string;
  newText: string;
  /** newText is a multi-file V4A patch; hunks do not apply. */
  isPatch: boolean;
}

export interface ReviewDecision {
  accept: boolean;
  cancelled?: boolean;
  acceptedHunks: number[];
  totalHunks: number;
}

interface Review {
  req: ReviewRequest;
  diff?: HunkDiff;
  accepted: Set<number>;
  resolve(decision: ReviewDecision): void;
}

type Side = "original" | "proposed" | "patch";

export class DiffReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly reviews = new Map<string, Review>();
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  readonly onDidChange = this.contentChanged.event;
  readonly onDidChangeCodeLenses = this.lensesChanged.event;

  constructor(
    private readonly locale: () => Locale,
    /** Lets the chat card reflect hunk toggles and decisions made in the editor. */
    private readonly onSelectionChanged: (id: string, accepted: number, total: number) => void,
  ) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: DIFF_SCHEME }, this),
      vscode.commands.registerCommand("hermes.diff.accept", (uri?: vscode.Uri) => this.decideFromEditor(uri, true)),
      vscode.commands.registerCommand("hermes.diff.reject", (uri?: vscode.Uri) => this.decideFromEditor(uri, false)),
      vscode.commands.registerCommand("hermes.diff.toggleHunk", (id: string, index: number) => this.toggleHunk(id, index)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKey()),
      this.contentChanged,
      this.lensesChanged,
    );
  }

  /** Opens the review and resolves once the user decides (or the review is cancelled). */
  start(req: ReviewRequest): Promise<ReviewDecision> {
    return new Promise((resolve) => {
      const diff = req.isPatch ? undefined : computeHunks(req.oldText, req.newText);
      const accepted = new Set(diff?.hunks.map((h) => h.index) ?? []);
      this.reviews.set(req.id, { req, diff, accepted, resolve });
      this.lensesChanged.fire();
      void this.show(req.id);
    });
  }

  async show(id: string): Promise<void> {
    const review = this.reviews.get(id);
    if (!review) return;
    const name = path.basename(review.req.path);
    if (review.req.isPatch) {
      const doc = await vscode.workspace.openTextDocument(this.uri(id, "patch", `${name}.diff`));
      await vscode.languages.setTextDocumentLanguage(doc, "diff");
      await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
    } else {
      await vscode.commands.executeCommand(
        "vscode.diff",
        this.uri(id, "original", name),
        this.uri(id, "proposed", name),
        t(this.locale(), "diff.title", name),
        { preview: false, preserveFocus: false } satisfies vscode.TextDocumentShowOptions,
      );
    }
    this.updateContextKey();
  }

  hunkCount(id: string): number {
    return this.reviews.get(id)?.diff?.hunks.length ?? 0;
  }

  /** Accept uses the current hunk selection (all hunks unless some were toggled off). */
  decide(id: string, accept: boolean): void {
    const review = this.reviews.get(id);
    if (!review) return;
    const total = review.diff?.hunks.length ?? 0;
    const acceptedHunks = accept ? [...review.accepted].sort((a, b) => a - b) : [];
    // Accepting with every hunk toggled off is a rejection.
    const effective = accept && (review.req.isPatch || total === 0 || acceptedHunks.length > 0);
    this.finish(id, { accept: effective, acceptedHunks: effective ? acceptedHunks : [], totalHunks: total });
  }

  cancel(id: string): void {
    this.finish(id, { accept: false, cancelled: true, acceptedHunks: [], totalHunks: this.hunkCount(id) });
  }

  cancelAll(): void {
    for (const id of [...this.reviews.keys()]) this.cancel(id);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const parsed = this.parse(uri);
    const review = parsed && this.reviews.get(parsed.id);
    if (!parsed || !review) return "";
    return parsed.side === "original" ? review.req.oldText : review.req.newText;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const parsed = this.parse(doc.uri);
    const review = parsed && this.reviews.get(parsed.id);
    if (!parsed || !review || parsed.side === "original") return [];
    const loc = this.locale();
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: t(loc, "diff.acceptAll"), command: "hermes.diff.accept", arguments: [doc.uri] }),
      new vscode.CodeLens(top, { title: t(loc, "diff.rejectAll"), command: "hermes.diff.reject", arguments: [doc.uri] }),
    ];
    if (parsed.side === "patch") {
      lenses.push(new vscode.CodeLens(top, { title: t(loc, "diff.patchOnly"), command: "" }));
      return lenses;
    }
    const hunks = review.diff?.hunks ?? [];
    if (hunks.length < 2) return lenses; // a single hunk is the same as accept/reject all
    for (const h of hunks) {
      const line = Math.min(h.newStart, Math.max(doc.lineCount - 1, 0));
      const key = review.accepted.has(h.index) ? "diff.hunkAccepted" : "diff.hunkRejected";
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: t(loc, key, h.index + 1),
        command: "hermes.diff.toggleHunk",
        arguments: [parsed.id, h.index],
      }));
    }
    return lenses;
  }

  dispose(): void {
    this.cancelAll();
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, false);
    for (const d of this.disposables) d.dispose();
  }

  private toggleHunk(id: string, index: number): void {
    const review = this.reviews.get(id);
    if (!review) return;
    if (review.accepted.has(index)) review.accepted.delete(index);
    else review.accepted.add(index);
    this.lensesChanged.fire();
    this.onSelectionChanged(id, review.accepted.size, review.diff?.hunks.length ?? 0);
  }

  private decideFromEditor(uri: vscode.Uri | undefined, accept: boolean): void {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    const parsed = target && this.parse(target);
    if (parsed) this.decide(parsed.id, accept);
  }

  private finish(id: string, decision: ReviewDecision): void {
    const review = this.reviews.get(id);
    if (!review) return;
    this.reviews.delete(id);
    review.resolve(decision);
    this.lensesChanged.fire();
    void this.closeTabs(id).then(() => this.updateContextKey());
  }

  private async closeTabs(id: string): Promise<void> {
    const ours = (uri: vscode.Uri | undefined) => !!uri && uri.scheme === DIFF_SCHEME && this.parse(uri)?.id === id;
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) return ours(input.modified) || ours(input.original);
      if (input instanceof vscode.TabInputText) return ours(input.uri);
      return false;
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  private updateContextKey(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const parsed = uri && this.parse(uri);
    void vscode.commands.executeCommand("setContext", CONTEXT_KEY, !!parsed && this.reviews.has(parsed.id));
  }

  private uri(id: string, side: Side, name: string): vscode.Uri {
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/${side}/${name}` });
  }

  private parse(uri: vscode.Uri): { id: string; side: Side } | undefined {
    if (uri.scheme !== DIFF_SCHEME) return undefined;
    const [, id, side] = uri.path.split("/");
    if (!id || (side !== "original" && side !== "proposed" && side !== "patch")) return undefined;
    return { id, side };
  }
}
