// Hermes versions this IDE was tested with, and how to install the tested build. The data lives in a JSON file so the
// extension host, the webview and the installer build script (ide/scripts) all read one source of truth.
import versions from "./hermesVersions.json";

/** Versions the ACP integration was validated against (PRD: pin supported versions). */
export const SUPPORTED_HERMES: { min: string; maxExclusive: string } = versions.supported;

/**
 * The exact Hermes build the integration tests ran against (v0.21.4). Onboarding installs this commit, not whatever
 * main is today, so a new user starts on a version known to work with the ACP integration.
 */
export const TESTED_HERMES: { version: string; commit: string } = versions.tested;

/** The official installer and the command template that runs it pinned to a commit. */
export const HERMES_INSTALL: { scriptUrl: string; commandTemplate: string } = versions.install;
