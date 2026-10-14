export interface Brand {
  name: string;
  applicationName: string;
  dataFolderName: string;
  mutexName: string;
  regValueName: string;
  appUserModelId: string;
  urlProtocol: string;
  publisher: string;
  repository: string;
  appIds: Record<string, string>;
  update: { feedUrl: string; downloadBase: string };
  base: {
    name: string;
    version: string;
    downloadBase: string;
    assets: Record<string, { file: string; sha256: string }>;
  };
  extensionDir: string;
  configurationDefaults: Record<string, unknown>;
}

export type Arch = "x64" | "arm64";

export function installerFileName(arch: string, version: string): string;
export function platformKey(arch: string): string;
export function patchProduct(
  base: Record<string, any>,
  brand: Brand,
  opts: { version: string; arch: Arch },
): Record<string, any>;
export function rewriteCmdLauncher(text: string, brand: Brand): string;
export function rewriteShLauncher(text: string, brand: Brand): string;
export function visualElementsManifest(brand: Brand): string;
export function windowsFileVersion(version: string): string;
export function encodeIco(images: { size: number; data: Buffer }[]): Buffer;
export function buildFeed(input: {
  version: string;
  releasedAt: string;
  notes?: string;
  installers: Record<string, { url: string; sha256: string; size: number }>;
}): { schema: 1; version: string; releasedAt: string; notes: string; installers: Record<string, { url: string; sha256: string; size: number }> };
export function issDefines(values: Record<string, string | number>): string;
export interface HermesVersions {
  supported: { min: string; maxExclusive: string };
  tested: { version: string; commit: string };
  install: { scriptUrl: string; commandTemplate: string };
}
export function hermesInstallCommand(versions: HermesVersions, opts?: { url?: string; commit?: string }): string;
