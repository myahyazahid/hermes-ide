// Reads the full-local-mode settings (phase 6) and answers "may this address / model be used?" for the IDE's own
// features. Both settings are application-scoped, so a project's .vscode/settings.json can neither switch the mode off
// nor add a server to the allowed list.
import * as vscode from "vscode";
import { classifyModelId, classifyUrl, isAcceptable } from "../core/privacy";

export interface PrivacySettings {
  localOnly: boolean;
  allowedHosts: string[];
}

export function privacySettings(): PrivacySettings {
  const cfg = vscode.workspace.getConfiguration("hermes.privacy");
  const hosts = cfg.get<unknown>("allowedHosts", []);
  return {
    localOnly: cfg.get<boolean>("localOnly", false),
    allowedHosts: Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string" && h.trim() !== "").map((h) => h.trim()) : [],
  };
}

/** True when local mode is on and `url` points somewhere it does not allow. Empty or invalid addresses are left to the feature itself. */
export function blockedByLocalMode(url: string): boolean {
  const p = privacySettings();
  if (!p.localOnly || !url.trim()) return false;
  const kind = classifyUrl(url, p.allowedHosts).kind;
  return kind !== "invalid" && !isAcceptable(kind);
}

/** True when local mode is on and the Hermes model id belongs to a remote or unknown provider. */
export function modelBlockedByLocalMode(modelId: string): boolean {
  const p = privacySettings();
  return p.localOnly && !isAcceptable(classifyModelId(modelId, p.allowedHosts));
}
