// Quick-start card for an empty chat (phase 5): is Hermes installed, is a model ready, what to try first.
// Each step shows its state and, when it is not done, the one action that completes it.
import { SUPPORTED_HERMES, TESTED_HERMES } from "../../src/shared/hermesVersions";
import { ENDPOINT_PRESETS, PRESET_GROUPS, STARTER_PROMPTS, type EndpointPreset } from "../../src/shared/presets";
import type { ViewState } from "../../src/shared/protocol";
import { t, type Locale } from "../../src/shared/strings";
import { send } from "./host";

/** Phases where the card can say something useful; the other banners cover trust and workspace problems. */
const SHOWN_IN = ["missing", "needsSetup", "ready", "stopped", "starting", "checking"];

export function showsOnboarding(state: ViewState, itemCount: number): boolean {
  return !!state.onboarding && itemCount === 0 && SHOWN_IN.includes(state.phase);
}

interface Props {
  state: ViewState;
  locale: Locale;
  onPreset(preset: EndpointPreset): void;
}

export function Onboarding({ state, locale, onPreset }: Props) {
  const hermesKnown = state.phase !== "missing" && state.phase !== "checking";
  const hermesOk = hermesKnown && !!state.hermesVersion;
  const ready = state.phase === "ready";
  const modelName = state.models.find((m) => m.id === state.currentModelId)?.label ?? state.currentModelId ?? "";
  const range = `>=${SUPPORTED_HERMES.min} <${SUPPORTED_HERMES.maxExclusive}`;

  return (
    <section className="card onboarding" aria-label={t(locale, "onboard.title")}>
      <div className="card-head">
        <span className="eyebrow">{t(locale, "onboard.title")}</span>
        <button type="button" className="ghost small" onClick={() => send({ type: "dismissOnboarding" })}>
          {t(locale, "onboard.hide")}
        </button>
      </div>

      <ol className="steps">
        <li className={`step ${hermesOk ? "done" : "todo"}`}>
          <span className="step-mark" aria-hidden>{hermesOk ? "✓" : "1"}</span>
          <div className="step-body">
            <div className="step-title">
              {t(locale, "onboard.hermes")}{" "}
              <span className="muted">{hermesOk ? t(locale, "onboard.hermesOk", state.hermesVersion ?? "") : t(locale, state.phase === "checking" ? "status.checking" : "onboard.hermesMissing")}</span>
            </div>
            {state.phase === "missing" && (
              <>
                <p className="hint">{state.canInstallHermes ? t(locale, "hermesMaint.installHint", TESTED_HERMES.version) : t(locale, "banner.missingInstall")}</p>
                <div className="row-actions">
                  {state.canInstallHermes && (
                    <button type="button" className="primary" onClick={() => send({ type: "installHermes" })}>{t(locale, "hermesMaint.install")}</button>
                  )}
                  <button type="button" className="secondary" onClick={() => send({ type: "recheck" })}>{t(locale, "action.recheck")}</button>
                </div>
              </>
            )}
            {hermesOk && state.hermesStatus && state.hermesStatus !== "tested" && (
              <p className="hint warn-text">{t(locale, state.hermesStatus === "newer" ? "hermesMaint.status.newer" : "hermesMaint.status.older", state.hermesVersion ?? "", range)}</p>
            )}
          </div>
        </li>

        <li className={`step ${ready ? "done" : "todo"}`}>
          <span className="step-mark" aria-hidden>{ready ? "✓" : "2"}</span>
          <div className="step-body">
            <div className="step-title">
              {t(locale, "onboard.model")}{" "}
              <span className="muted">{ready ? t(locale, "onboard.modelOk", modelName) : hermesOk ? t(locale, "onboard.modelNeeded") : ""}</span>
            </div>
            {hermesOk && !ready && state.phase !== "starting" && (
              <>
                <p className="hint">{t(locale, "onboard.pickProvider")}</p>
                {PRESET_GROUPS.map((group) => (
                  <div key={group}>
                    <div className="preset-group muted">{t(locale, `presets.group.${group}`)}</div>
                    <div className="preset-row">
                      {ENDPOINT_PRESETS.filter((p) => p.group === group).map((p) => (
                        <button key={p.id} type="button" className="secondary small" onClick={() => onPreset(p)}>
                          {p.label} <span className="muted">· {t(locale, p.needsKey ? "onboard.needKey" : "onboard.noKey")}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                <button type="button" className="link-btn" onClick={() => send({ type: "runHermesSetup" })}>{t(locale, "hermesMaint.wizard")}</button>
              </>
            )}
          </div>
        </li>

        <li className={`step ${ready ? "todo" : "later"}`}>
          <span className="step-mark" aria-hidden>3</span>
          <div className="step-body">
            <div className="step-title">{t(locale, "onboard.try")}</div>
            {ready && (
              <>
                <p className="hint">{t(locale, "onboard.tryHint")}</p>
                <ul className="starters">
                  {STARTER_PROMPTS[locale].map((text) => (
                    <li key={text}>
                      <button type="button" className="starter" onClick={() => window.dispatchEvent(new CustomEvent("hermes:insert", { detail: text }))}>
                        {text}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}
