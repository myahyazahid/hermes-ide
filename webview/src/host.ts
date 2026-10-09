import type { ViewToHost } from "../../src/shared/protocol";

interface VsCodeApi {
  postMessage(msg: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = acquireVsCodeApi();

export function send(msg: ViewToHost): void {
  api.postMessage(msg);
}
