// Pure helpers for building the standalone IDE (phase 4). No file or network access, so they can be unit-tested.

/** Name of the installer produced for one architecture, e.g. `HermesIDE-Setup-x64-0.4.0.exe`. */
export function installerFileName(arch, version) {
  return `HermesIDE-Setup-${arch}-${version}.exe`;
}

/** Key used in `latest.json` and by the in-IDE updater to pick the right installer. */
export function platformKey(arch) {
  return `win32-${arch}`;
}

/**
 * Brands the upstream VSCodium product.json. Overrides identity (names, data folders, installer ids, mutexes)
 * and removes everything that would point the IDE back at VSCodium: its update feed, server download and
 * Windows 11 context-menu CLSIDs. `checksums` is left alone; it only covers workbench files we never touch.
 */
export function patchProduct(base, brand, { version, arch }) {
  if (!brand.appIds?.[arch]) throw new Error(`brand.json has no appIds.${arch}`);
  if (!String(base.extensionsGallery?.serviceUrl ?? "").startsWith("https://open-vsx.org/")) {
    throw new Error("Base product.json does not use Open VSX as its extension gallery; refusing to build (PRD requires Open VSX).");
  }
  const product = structuredClone(base);
  const appId = brand.appIds[arch];
  const name = brand.name;
  Object.assign(product, {
    nameShort: name,
    nameLong: name,
    applicationName: brand.applicationName,
    dataFolderName: brand.dataFolderName,
    sharedDataFolderName: `${brand.dataFolderName}-shared`,
    win32MutexName: brand.mutexName,
    serverApplicationName: `${brand.applicationName}-server`,
    serverDataFolderName: `${brand.dataFolderName}-server`,
    tunnelApplicationName: `${brand.applicationName}-tunnel`,
    win32DirName: name,
    win32NameVersion: name,
    win32RegValueName: brand.regValueName,
    win32AppUserModelId: brand.appUserModelId,
    win32ShellNameShort: name,
    win32TunnelServiceMutex: `${brand.mutexName}-tunnelservice`,
    win32TunnelMutex: `${brand.mutexName}-tunnel`,
    win32AppId: appId,
    win32UserAppId: appId,
    [`win32${arch}AppId`]: appId,
    [`win32${arch}UserAppId`]: appId,
    urlProtocol: brand.urlProtocol,
    reportIssueUrl: `${brand.repository}/issues/new`,
    downloadUrl: `${brand.repository}/releases`,
    configurationDefaults: { ...(base.configurationDefaults ?? {}), ...brand.configurationDefaults },
    // Read by the bundled extension (src/core/ideInfo.ts); its presence is what marks "running as the standalone IDE".
    hermesIde: {
      version,
      arch,
      installer: "user",
      updateFeedUrl: brand.update.feedUrl,
    },
  });
  // The stock updater cannot work here (the zip has no inno_updater.exe) and its feed would replace us with VSCodium.
  for (const key of ["updateUrl", "serverDownloadUrlTemplate", "win32ContextMenu"]) delete product[key];
  return product;
}

function replaceOnce(text, pattern, replacement, what) {
  if (!pattern.test(text)) throw new Error(`Upstream launcher script changed shape: could not find ${what}. Review ide/scripts/lib.mjs after bumping the base version.`);
  return text.replace(pattern, () => replacement);
}

/** `bin/codium.cmd` -> content for `bin/<applicationName>.cmd`. */
export function rewriteCmdLauncher(text, brand) {
  return replaceOnce(text, /VSCodium\.exe/g, `${brand.name}.exe`, "VSCodium.exe");
}

/** `bin/codium` (sh) -> content for `bin/<applicationName>`. */
export function rewriteShLauncher(text, brand) {
  let out = text;
  out = replaceOnce(out, /^APP_NAME="codium"$/m, `APP_NAME="${brand.applicationName}"`, 'APP_NAME="codium"');
  out = replaceOnce(out, /^NAME="VSCodium"$/m, `NAME="${brand.name}"`, 'NAME="VSCodium"');
  out = replaceOnce(out, /^SERVERDATAFOLDER="[^"]*"$/m, `SERVERDATAFOLDER="${brand.dataFolderName}-server"`, "SERVERDATAFOLDER");
  return out;
}

/** Windows tile definition, named `<exe basename>.VisualElementsManifest.xml`. */
export function visualElementsManifest(brand) {
  return `<Application xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
	<VisualElements
		BackgroundColor="#1b1d2a"
		ShowNameOnSquare150x150Logo="on"
		Square150x150Logo="resources\\app\\resources\\win32\\code_150x150.png"
		Square70x70Logo="resources\\app\\resources\\win32\\code_70x70.png"
		ForegroundText="light"
		ShortDisplayName="${brand.name}" />
</Application>
`;
}

/** `0.4.0` or `0.4.0-beta.1` -> `0.4.0.0`, the four-part form Windows version resources require. */
export function windowsFileVersion(version) {
  const core = String(version).split(/[-+]/)[0].split(".").map((n) => Number.parseInt(n, 10));
  if (core.length < 1 || core.length > 4 || core.some((n) => !Number.isInteger(n) || n < 0 || n > 65535)) {
    throw new Error(`Cannot convert "${version}" to a Windows file version`);
  }
  while (core.length < 4) core.push(0);
  return core.join(".");
}

/** Packs PNG images into a Vista-style .ico (each entry stores the PNG as-is). `images` is `[{ size, data: Buffer }]`. */
export function encodeIco(images) {
  if (!images.length) throw new Error("encodeIco needs at least one image");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    if (size < 1 || size > 256) throw new Error(`ICO sizes must be 1..256, got ${size}`);
    const at = i * 16;
    dir.writeUInt8(size === 256 ? 0 : size, at); // width (0 means 256)
    dir.writeUInt8(size === 256 ? 0 : size, at + 1); // height
    dir.writeUInt8(0, at + 2); // palette size
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

/** Release feed read by the in-IDE updater. `installers` maps platform keys to `{ url, sha256, size }`. */
export function buildFeed({ version, releasedAt, notes, installers }) {
  for (const [key, entry] of Object.entries(installers)) {
    if (!/^https:\/\//.test(entry.url)) throw new Error(`Installer URL for ${key} must be https: ${entry.url}`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`Installer sha256 for ${key} must be 64 lowercase hex chars`);
  }
  return { schema: 1, version, releasedAt, notes: notes ?? "", installers };
}

/**
 * The PowerShell command that installs Hermes at the tested commit; the same template the extension uses
 * (src/core/hermesMaintenance.ts), read from src/shared/hermesVersions.json. A unit test keeps the two in step.
 */
export function hermesInstallCommand(versions, opts = {}) {
  const url = opts.url ?? versions.install.scriptUrl;
  const commit = opts.commit ?? versions.tested.commit;
  if (!/^https:\/\//.test(url) || /['"`$\s]/.test(url)) throw new Error(`Unsafe install script URL: ${url}`);
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error(`Not a git commit id: ${commit}`);
  return versions.install.commandTemplate.replace("{url}", () => url).replace("{commit}", () => commit);
}

/** Renders `#define` lines for the Inno Setup preprocessor. Values are quoted; embedded quotes are doubled. */
export function issDefines(values) {
  return Object.entries(values)
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Bad define name: ${name}`);
      return `#define ${name} "${String(value).replaceAll('"', '""')}"`;
    })
    .join("\n") + "\n";
}
