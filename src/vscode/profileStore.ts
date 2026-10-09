// Endpoint profiles (F-16) persisted in user settings (`hermes.profiles`, `hermes.activeProfile`);
// API keys stay in SecretStorage, one entry per profile.
import * as vscode from "vscode";
import { maskKey } from "../core/endpoint";
import {
  HERMES_PROFILE_ID, LEGACY_SECRET_KEY, migrateLegacyEndpoint, newProfileId, sanitizeProfiles, secretKeyFor,
  type EndpointProfile,
} from "../core/profiles";
import type { ProfileInput, ProfileView } from "../shared/protocol";

const target = vscode.ConfigurationTarget.Global;

export class ProfileStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private get cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("hermes");
  }

  list(): EndpointProfile[] {
    return sanitizeProfiles(this.cfg.get("profiles"));
  }

  activeId(): string {
    const id = this.cfg.get<string>("activeProfile") || HERMES_PROFILE_ID;
    return id === HERMES_PROFILE_ID || this.list().some((p) => p.id === id) ? id : HERMES_PROFILE_ID;
  }

  /** Undefined when the active profile is the user's own Hermes config. */
  active(): EndpointProfile | undefined {
    const id = this.activeId();
    return this.list().find((p) => p.id === id);
  }

  key(id: string): Thenable<string | undefined> {
    return this.secrets.get(secretKeyFor(id));
  }

  async allKeys(): Promise<string[]> {
    const keys = await Promise.all(this.list().map((p) => this.key(p.id)));
    return keys.filter((k): k is string => !!k);
  }

  async views(hermesLabel: string): Promise<ProfileView[]> {
    const custom = await Promise.all(
      this.list().map(async (p): Promise<ProfileView> => {
        const key = await this.key(p.id);
        return {
          id: p.id, name: p.name, kind: "custom", baseUrl: p.baseUrl, model: p.model,
          contextLength: p.contextLength ?? 0, keyHint: maskKey(key), hasKey: !!key,
        };
      }),
    );
    return [
      { id: HERMES_PROFILE_ID, name: hermesLabel, kind: "hermes", baseUrl: "", model: "", contextLength: 0, keyHint: "", hasKey: false },
      ...custom,
    ];
  }

  async save(input: ProfileInput, apiKey?: string): Promise<string> {
    const profiles = this.list();
    const id = input.id && profiles.some((p) => p.id === input.id) ? input.id : newProfileId(input.name, profiles.map((p) => p.id));
    const profile: EndpointProfile = {
      id,
      name: input.name.trim() || id,
      baseUrl: input.baseUrl.trim(),
      model: input.model.trim(),
      contextLength: input.contextLength > 0 ? Math.floor(input.contextLength) : undefined,
    };
    const next = profiles.some((p) => p.id === id) ? profiles.map((p) => (p.id === id ? profile : p)) : [...profiles, profile];
    await this.cfg.update("profiles", next, target);
    if (apiKey !== undefined) {
      if (apiKey === "") await this.secrets.delete(secretKeyFor(id));
      else await this.secrets.store(secretKeyFor(id), apiKey.trim());
    }
    return id;
  }

  async delete(id: string): Promise<void> {
    if (id === HERMES_PROFILE_ID) return;
    await this.cfg.update("profiles", this.list().filter((p) => p.id !== id), target);
    await this.secrets.delete(secretKeyFor(id));
    if (this.activeId() === id) await this.select(HERMES_PROFILE_ID);
  }

  async select(id: string): Promise<void> {
    await this.cfg.update("activeProfile", id, target);
  }

  /** Phase 1 kept one endpoint in `hermes.endpoint.*`; turn it into a profile once. */
  async migrateLegacy(): Promise<boolean> {
    if (this.list().length) return false;
    const legacy = migrateLegacyEndpoint({
      mode: this.cfg.get<string>("endpoint.mode"),
      baseUrl: this.cfg.get<string>("endpoint.baseUrl"),
      model: this.cfg.get<string>("endpoint.model"),
      contextLength: this.cfg.get<number>("endpoint.contextLength"),
    });
    if (!legacy) return false;
    await this.cfg.update("profiles", [legacy.profile], target);
    const key = await this.secrets.get(LEGACY_SECRET_KEY);
    if (key) {
      await this.secrets.store(secretKeyFor(legacy.profile.id), key);
      await this.secrets.delete(LEGACY_SECRET_KEY);
    }
    if (legacy.active) await this.select(legacy.profile.id);
    for (const k of ["endpoint.mode", "endpoint.baseUrl", "endpoint.model", "endpoint.contextLength"]) {
      await this.cfg.update(k, undefined, target);
    }
    return true;
  }
}
