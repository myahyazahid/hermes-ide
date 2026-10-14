// Full-size preview of an attached image, like Claude Code's: opened from any image chip, closed with Esc or a click.
import { useEffect, useState } from "react";
import { t, type Locale } from "../../src/shared/strings";

interface Shown {
  src: string;
  name: string;
}

export function showImage(src: string, name: string): void {
  window.dispatchEvent(new CustomEvent<Shown>("hermes:image", { detail: { src, name } }));
}

export function ImagePreview({ locale }: { locale: Locale }) {
  const [shown, setShown] = useState<Shown>();

  useEffect(() => {
    const onShow = (e: Event) => setShown((e as CustomEvent<Shown>).detail);
    window.addEventListener("hermes:image", onShow);
    return () => window.removeEventListener("hermes:image", onShow);
  }, []);

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setShown(undefined);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);

  if (!shown) return null;
  return (
    <div className="image-preview" role="dialog" aria-modal="true" aria-label={shown.name} onClick={() => setShown(undefined)}>
      <div className="image-preview-bar" onClick={(e) => e.stopPropagation()}>
        <span className="mono">{shown.name}</span>
        <button type="button" className="icon" aria-label={t(locale, "image.close")} title={`${t(locale, "image.close")} (Esc)`} onClick={() => setShown(undefined)}>
          ×
        </button>
      </div>
      <img src={shown.src} alt={shown.name} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
