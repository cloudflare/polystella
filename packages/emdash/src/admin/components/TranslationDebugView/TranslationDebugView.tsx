import { Badge, Button, LayerCard, Tabs } from "@cloudflare/kumo";
import { useState, type CSSProperties, type ReactNode } from "react";

import type { TranslationDebugAttempt, TranslationDebugTrace, TranslationUsage } from "../../../contracts.js";
import { cardStyle, codeStyle, mutedStyle, rowStyle, stackStyle } from "../../styles.js";
import { localeLabel, plural } from "../../utils.js";
import { UsageTooltip } from "../PageHeader/PageHeader.js";

export function TranslationDebugView({ trace, onDismiss }: { trace: TranslationDebugTrace; onDismiss(): void }): ReactNode {
  const number = (value: number) => value.toLocaleString();
  const facts: Array<[string, ReactNode]> = [
    ["Diagnostic ID", <code key="id">{trace.id}</code>],
    ["Model", `${trace.provider} · ${trace.model}`],
    ["Locales", `${localeLabel(trace.sourceLocale)} → ${localeLabel(trace.targetLocale)}`],
    ["Requests", `${plural(trace.batchCount, "batch", "batches")}, ${plural(trace.providerCallCount, "provider call")}`],
    ["Duration", `${number(trace.durationMs)} ms`],
    ["Input budget", `${number(trace.inputTokenBudget)} estimated tokens`],
    ...(trace.maxSegmentsPerBatch === null
      ? []
      : [["Segments per batch", `at most ${trace.maxSegmentsPerBatch}`] satisfies [string, ReactNode]]),
    ["Max output", `${number(trace.maxOutputTokens)} tokens`],
    [
      "Extra request input",
      trace.requestInput === null || trace.requestInput === undefined ? (
        "none"
      ) : (
        <code key="input">{JSON.stringify(trace.requestInput)}</code>
      ),
    ],
  ];
  return (
    <LayerCard style={cardStyle}>
      <div style={stackStyle}>
        <div style={rowStyle}>
          <h3 style={{ margin: 0 }}>Translation debug</h3>
          {trace.error === null ? <Badge variant="success">Completed</Badge> : <Badge variant="error">Failed</Badge>}
          <Button size="sm" variant="secondary" onClick={() => downloadTranslationDebug(trace)}>
            Download JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
        <dl style={factsStyle}>
          {facts.map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt style={mutedStyle}>{label}</dt>
              <dd style={{ margin: 0, minWidth: 0, overflowWrap: "anywhere" }}>{value}</dd>
            </div>
          ))}
        </dl>
        {trace.error === null ? null : <pre style={codeStyle}>{trace.error}</pre>}
        {trace.validationIssues.length === 0 ? null : (
          <details>
            <summary>{plural(trace.validationIssues.length, "validation issue")}</summary>
            <pre style={codeStyle}>{trace.validationIssues.join("\n")}</pre>
          </details>
        )}
        {trace.batches.map((batch) => (
          <details key={batch.batch}>
            <summary>
              Batch {batch.batch} · {plural(batch.segmentCount, "segment")} · about {number(batch.estimatedInputTokens)} input tokens
              {batch.attempts.some((attempt) => attempt.error !== null) ? ` · ${plural(batch.attempts.length, "attempt")}` : ""}
            </summary>
            <div style={{ ...stackStyle, padding: "12px 0 0 16px" }}>
              <small style={{ ...mutedStyle, overflowWrap: "anywhere" }}>
                {number(batch.sourceCharacters)} source characters
                {batch.glossaryTerms === undefined
                  ? ""
                  : ` · ${batch.glossaryTerms.sent} of ${batch.glossaryTerms.total} glossary terms sent`}{" "}
                · Segments: {batch.segmentLabels.join(", ")}
              </small>
              <BatchAttempts attempts={batch.attempts} />
            </div>
          </details>
        ))}
      </div>
    </LayerCard>
  );
}

type AttemptTab = "system" | "user" | "response" | "parsed" | "error";

function BatchAttempts({ attempts }: { attempts: readonly TranslationDebugAttempt[] }): ReactNode {
  const [chosenAttempt, setChosenAttempt] = useState<string | null>(null);
  const [chosenTab, setChosenTab] = useState<AttemptTab>("system");
  const attempt = attempts.find((item) => String(item.attempt) === chosenAttempt) ?? attempts[attempts.length - 1];
  if (attempt === undefined) return null;
  const tabs: Array<{ value: AttemptTab; label: string; body: string }> = [
    { value: "system", label: "System prompt", body: attempt.systemPrompt },
    { value: "user", label: "User prompt", body: attempt.userPrompt },
    ...(attempt.response === null ? [] : [{ value: "response" as const, label: "Response", body: attempt.response }]),
    ...(attempt.translations === null
      ? []
      : [{ value: "parsed" as const, label: "Parsed", body: JSON.stringify(attempt.translations, null, 2) }]),
    ...(attempt.error === null ? [] : [{ value: "error" as const, label: "Error", body: attempt.error }]),
  ];
  const active = tabs.find((tab) => tab.value === chosenTab) ?? tabs[0];
  if (active === undefined) return null;
  return (
    <div style={stackStyle}>
      {attempts.length > 1 ? (
        <Tabs
          variant="segmented"
          size="sm"
          tabs={attempts.map((item) => ({
            value: String(item.attempt),
            label: `Attempt ${item.attempt}${item.error === null ? "" : " (failed)"}`,
          }))}
          value={String(attempt.attempt)}
          onValueChange={(value) => setChosenAttempt(String(value))}
        />
      ) : null}
      <div style={rowStyle}>
        {attempt.error === null ? <Badge variant="success">Completed</Badge> : <Badge variant="error">Failed</Badge>}
        <small style={mutedStyle}>in {attempt.durationMs.toLocaleString()} ms</small>
      </div>
      {attempt.providerResponse === undefined ? null : (
        <small style={{ ...mutedStyle, overflowWrap: "anywhere" }}>
          <UsageTooltip usage={attemptUsage(attempt)}>{describeProviderResponse(attempt.providerResponse)}</UsageTooltip>
        </small>
      )}
      <Tabs
        variant="underline"
        size="sm"
        tabs={tabs.map(({ value, label }) => ({ value, label }))}
        value={active.value}
        onValueChange={(value) => {
          const next = tabs.find((tab) => tab.value === value);
          if (next !== undefined) setChosenTab(next.value);
        }}
      />
      <div role="tabpanel" aria-label={active.label}>
        <pre style={codeStyle}>{active.body}</pre>
      </div>
    </div>
  );
}

function downloadTranslationDebug(trace: TranslationDebugTrace): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(trace, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `polystella-${trace.operation}-debug.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** One call's usage, for its cost tooltip; `undefined` when the provider reported no token counts. */
function attemptUsage({ providerResponse: info, estimatedCostUsd }: TranslationDebugAttempt): TranslationUsage | undefined {
  if (info?.inputTokens === undefined || info.outputTokens === undefined) return undefined;
  return {
    calls: 1,
    inputTokens: info.inputTokens,
    cachedInputTokens: Math.min(info.cachedInputTokens ?? 0, info.inputTokens),
    outputTokens: info.outputTokens,
    reasoningTokens: Math.min(info.reasoningTokens ?? 0, info.outputTokens),
    unreportedCalls: 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

/** `finish: stop · input 2,104 tokens · output 3,388 tokens (2,950 reasoning) · reasoning text 9,812 characters`. */
function describeProviderResponse(info: NonNullable<TranslationDebugAttempt["providerResponse"]>): string {
  const number = (value: number) => value.toLocaleString("en-US");
  const parts = [
    info.finishReason === undefined ? null : `finish: ${info.finishReason}`,
    info.inputTokens === undefined ? null : `input ${number(info.inputTokens)} tokens`,
    info.outputTokens === undefined
      ? null
      : `output ${number(info.outputTokens)} tokens${info.reasoningTokens === undefined ? "" : ` (${number(info.reasoningTokens)} reasoning)`}`,
    info.reasoningCharacters === undefined ? null : `reasoning text ${number(info.reasoningCharacters)} characters`,
  ];
  return parts.filter((part) => part !== null).join(" · ") || "The provider reported nothing about this reply.";
}

const factsStyle: CSSProperties = {
  columnGap: 16,
  display: "grid",
  fontSize: 13,
  gridTemplateColumns: "max-content minmax(0, 1fr)",
  margin: 0,
  rowGap: 4,
};
