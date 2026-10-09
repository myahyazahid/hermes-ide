// Ctrl+K inline edit (F-13): select code, describe the change, review the result as a diff that
// opens in place of the editor.
import * as vscode from "vscode";
import { t } from "../shared/strings";
import type { HermesService } from "./hermesService";

export async function runInlineEdit(service: HermesService): Promise<void> {
  const loc = service.locale;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    void vscode.window.showInformationMessage(t(loc, "inline.noEditor"));
    return;
  }
  const doc = editor.document;
  // No selection: edit the current line.
  const sel = editor.selection.isEmpty ? doc.lineAt(editor.selection.active.line).range : editor.selection;
  const startLine = sel.start.line + 1;
  // A selection ending at column 0 of the next line does not include that line.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const range = new vscode.Range(startLine - 1, 0, endLine - 1, doc.lineAt(endLine - 1).text.length);
  if (doc.isDirty) await doc.save(); // Hermes edits the file on disk

  const instruction = await vscode.window.showInputBox({
    title: t(loc, "inline.title", vscode.workspace.asRelativePath(doc.uri), startLine, endLine),
    prompt: t(loc, "inline.prompt"),
    placeHolder: t(loc, "inline.placeholder"),
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const highlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.findRangeHighlightBackground"),
    isWholeLine: true,
  });
  editor.setDecorations(highlight, [range]);
  try {
    const reply = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t(loc, "inline.running"), cancellable: true },
      (_progress, token) =>
        service.inlineEdit(
          { path: doc.uri.fsPath, startLine, endLine, text: doc.getText(range), languageId: doc.languageId, instruction: instruction.trim() },
          token,
        ),
    );
    if (reply.trim()) vscode.window.setStatusBarMessage(`Hermes: ${reply.trim().split("\n")[0]}`, 8000);
  } catch (error) {
    void vscode.window.showErrorMessage(t(loc, "inline.failed", (error as Error).message));
  } finally {
    highlight.dispose();
  }
}
