; Hermes IDE installer (Inno Setup 6.3+). ide/scripts/build.mjs prepends the #define lines this script relies on:
; AppName, AppVersion, AppId, AppUserModelId, RegName, Publisher, RepoUrl, ExeName, AppCommand, MutexName, Arch,
; StageDir, OutputDir, OutputBase, IconFile, Compression, MaxAppDirLength, HermesVersion, HermesInstallCommand
; (and ForceHermesMissing, a test hook).
;
; Per-user by default (no admin prompt, so the in-IDE updater can run it silently). Upgrading is installing over
; the same AppId: `Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /UPDATE=1` closes the old IDE and relaunches.

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#Publisher}
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; commandline: lets an admin (or a test) force /CURRENTUSER or /ALLUSERS instead of inheriting the previous install's mode.
PrivilegesRequiredOverridesAllowed=commandline dialog
MinVersion=10.0
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#ExeName}
UninstallDisplayName={#AppName}
Compression={#Compression}
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
CloseApplications=yes
RestartApplications=no
; The IDE watches "<mutex>-setup" to know an installer is running (see win32MutexName in product.json).
SetupMutex={#MutexName}-setup
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "addcontextmenufiles"; Description: "Add ""Open with {#AppName}"" to the Explorer file context menu"; GroupDescription: "Other:"
Name: "addcontextmenufolders"; Description: "Add ""Open with {#AppName}"" to the Explorer folder context menu"; GroupDescription: "Other:"
Name: "addtopath"; Description: "Add {#AppCommand} to PATH (takes effect in new terminals)"; GroupDescription: "Other:"
; Offered (and ticked) in the wizard only when Hermes is not installed. A silent install never runs it unless asked with
; /INSTALLHERMES=1: silent installs reuse the previous install's task choices, so a task alone is not a safe opt-in.
Name: "installhermes"; Description: "Install Hermes Agent {#HermesVersion}, the version tested with this IDE (runs the official installer in a PowerShell window)"; GroupDescription: "Hermes Agent:"; Flags: unchecked; Check: not HermesInstalled

; Everything under resources\ and locales\ belongs to the IDE, so stale files from older versions are dropped first.
[InstallDelete]
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#ExeName}"; AppUserModelID: "{#AppUserModelId}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon; AppUserModelID: "{#AppUserModelId}"

[Run]
; Hermes first, so the IDE that starts afterwards finds it. The installer script shows its own progress and setup wizard.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""{#HermesInstallCommand}"""; StatusMsg: "Installing Hermes Agent (follow the PowerShell window)..."; Flags: waituntilterminated; Check: ShouldInstallHermes
Filename: "{app}\{#ExeName}"; Description: "{cm:LaunchProgram,{#StringChange(AppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
; After an in-IDE update the old window is gone, so bring the new one back.
Filename: "{app}\{#ExeName}"; Flags: nowait runasoriginaluser; Check: IsUpdateRun

[Registry]
; Explorer context menu (classic entries, per-user or per-machine depending on the install mode).
Root: HKA; Subkey: "Software\Classes\*\shell\{#RegName}"; ValueType: expandsz; ValueName: ""; ValueData: "Open with {#AppName}"; Tasks: addcontextmenufiles; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\*\shell\{#RegName}"; ValueType: expandsz; ValueName: "Icon"; ValueData: "{app}\{#ExeName}"; Tasks: addcontextmenufiles
Root: HKA; Subkey: "Software\Classes\*\shell\{#RegName}\command"; ValueType: expandsz; ValueName: ""; ValueData: """{app}\{#ExeName}"" ""%1"""; Tasks: addcontextmenufiles
Root: HKA; Subkey: "Software\Classes\Directory\shell\{#RegName}"; ValueType: expandsz; ValueName: ""; ValueData: "Open with {#AppName}"; Tasks: addcontextmenufolders; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Directory\shell\{#RegName}"; ValueType: expandsz; ValueName: "Icon"; ValueData: "{app}\{#ExeName}"; Tasks: addcontextmenufolders
Root: HKA; Subkey: "Software\Classes\Directory\shell\{#RegName}\command"; ValueType: expandsz; ValueName: ""; ValueData: """{app}\{#ExeName}"" ""%V"""; Tasks: addcontextmenufolders
Root: HKA; Subkey: "Software\Classes\Directory\Background\shell\{#RegName}"; ValueType: expandsz; ValueName: ""; ValueData: "Open with {#AppName}"; Tasks: addcontextmenufolders; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Directory\Background\shell\{#RegName}"; ValueType: expandsz; ValueName: "Icon"; ValueData: "{app}\{#ExeName}"; Tasks: addcontextmenufolders
Root: HKA; Subkey: "Software\Classes\Directory\Background\shell\{#RegName}\command"; ValueType: expandsz; ValueName: ""; ValueData: """{app}\{#ExeName}"" ""%V"""; Tasks: addcontextmenufolders
; PATH gets {app}\bin so `hermes-ide .` works in a terminal. The value is removed again on uninstall (see [Code]).
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Tasks: addtopath; Check: NeedsAddPath(False)
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Tasks: addtopath; Check: NeedsAddPath(True)

[Code]
var
  HermesTaskPreselected: Boolean;

function HermesInstalled: Boolean;
begin
#ifdef ForceHermesMissing
  Result := False;
#else
  Result := FileExists(ExpandConstant('{localappdata}\hermes\bin\hermes.exe')) or (FileSearch('hermes.exe', GetEnv('PATH')) <> '');
#endif
end;

// New users get the Hermes install ticked in the wizard.
procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpSelectTasks) and not HermesTaskPreselected then begin
    HermesTaskPreselected := True;
    if not HermesInstalled then WizardSelectTasks('installhermes');
  end;
end;

function IsUpdateRun: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:update|0}') = '1');
end;

// Wizard: the ticked task decides. Silent: only the explicit /INSTALLHERMES=1. Never during an update, never if Hermes is there.
function ShouldInstallHermes: Boolean;
begin
  if WizardSilent then
    Result := ExpandConstant('{param:installhermes|0}') = '1'
  else
    Result := WizardIsTaskSelected('installhermes');
  Result := Result and (not IsUpdateRun) and (not HermesInstalled);
end;

function EnvRoot(Machine: Boolean): Integer;
begin
  if Machine then Result := HKEY_LOCAL_MACHINE else Result := HKEY_CURRENT_USER;
end;

function EnvKey(Machine: Boolean): String;
begin
  if Machine then Result := 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' else Result := 'Environment';
end;

// True only for the registry row that matches the install mode, and only when {app}\bin is not on PATH yet.
function NeedsAddPath(Machine: Boolean): Boolean;
var
  Existing: String;
begin
  if Machine <> IsAdminInstallMode then begin
    Result := False;
    Exit;
  end;
  if not RegQueryStringValue(EnvRoot(Machine), EnvKey(Machine), 'Path', Existing) then Existing := '';
  Result := Pos(';' + Uppercase(ExpandConstant('{app}\bin')) + ';', ';' + Uppercase(Existing) + ';') = 0;
end;

procedure RemoveFromPath;
var
  Machine: Boolean;
  Existing, Entry, Cleaned: String;
  P: Integer;
begin
  Machine := IsAdminInstallMode;
  if not RegQueryStringValue(EnvRoot(Machine), EnvKey(Machine), 'Path', Existing) then Exit;
  Entry := ExpandConstant('{app}\bin');
  Cleaned := ';' + Existing + ';';
  P := Pos(Uppercase(';' + Entry + ';'), Uppercase(Cleaned));
  while P > 0 do begin
    Delete(Cleaned, P, Length(Entry) + 1);
    P := Pos(Uppercase(';' + Entry + ';'), Uppercase(Cleaned));
  end;
  Cleaned := Copy(Cleaned, 2, Length(Cleaned) - 2);
  if Cleaned <> Existing then
    RegWriteExpandStringValue(EnvRoot(Machine), EnvKey(Machine), 'Path', Cleaned);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveFromPath;
end;

// Refuses folders that would push the deepest bundled file past Windows' 260-character path limit, instead of
// failing halfway through the copy. Also, for an update, waits for the IDE that launched it to finish shutting down.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Waited: Integer;
begin
  Result := '';
  if Length(ExpandConstant('{app}')) > {#MaxAppDirLength} then begin
    Result := 'The install folder path is too long (' + IntToStr(Length(ExpandConstant('{app}'))) + ' characters, at most {#MaxAppDirLength}). Choose a shorter folder, for example C:\Programs\{#AppName}.';
    Exit;
  end;
  if IsUpdateRun then begin
    Waited := 0;
    while CheckForMutexes('{#MutexName}') and (Waited < 60000) do begin
      Sleep(500);
      Waited := Waited + 500;
    end;
  end;
end;
