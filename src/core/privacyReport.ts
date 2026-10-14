// The "privacy check" as a Markdown document (phase 6): every place data could go, and what the IDE does about it.
import { t, type Locale, type StringKey } from "../shared/strings";
import type { PrivacyReport } from "./privacy";

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function privacyReportMarkdown(report: PrivacyReport, locale: Locale): string {
  const rows = report.items.map((item) => {
    const area = t(locale, `privacy.area.${item.id}` as StringKey);
    const verdict = t(locale, `privacy.verdict.${item.verdict}` as StringKey);
    const note = t(locale, item.reason, ...(item.args ?? []));
    return `| ${cell(area)} | ${item.target ? `\`${cell(item.target)}\`` : ""} | ${verdict} | ${cell(note)} |`;
  });
  return [
    `# ${t(locale, "privacy.reportTitle")}`,
    t(locale, report.localOnly ? "privacy.reportOn" : "privacy.reportOff"),
    [
      `| ${t(locale, "privacy.colArea")} | ${t(locale, "privacy.colTarget")} | ${t(locale, "privacy.colVerdict")} | ${t(locale, "privacy.colNote")} |`,
      "| --- | --- | --- | --- |",
      ...rows,
    ].join("\n"),
    t(locale, "privacy.reportLimits"),
  ].join("\n\n") + "\n";
}
