import { Button, LayerCard } from "@cloudflare/kumo";
import type { ReactNode } from "react";

import type { TranslationDebugTrace } from "../../../contracts.js";
import { cardStyle, codeStyle, mutedStyle, rowStyle, stackStyle } from "../../styles.js";

export function TranslationDebugView({ trace, onDismiss }: { trace: TranslationDebugTrace; onDismiss(): void }): ReactNode {
  return (
    <LayerCard style={cardStyle}>
      <div style={stackStyle}>
        <div style={rowStyle}>
          <h3 style={{ margin: 0 }}>Translation debug</h3>
          <Button size="sm" variant="secondary" onClick={() => downloadTranslationDebug(trace)}>
            Download JSON
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
        <small style={mutedStyle}>
          ID: {trace.id} | {trace.provider} | {trace.model} | {trace.sourceLocale} to {trace.targetLocale} | {trace.batchCount} batches |{" "}
          {trace.providerCallCount} provider calls | {trace.durationMs} ms
        </small>
        <small style={mutedStyle}>
          Input budget: {trace.inputTokenBudget} estimated tokens
          {trace.maxSegmentsPerBatch === null ? "" : ` | Maximum ${trace.maxSegmentsPerBatch} segments per batch`} | Maximum output:{" "}
          {trace.maxOutputTokens} tokens
        </small>
        {trace.error === null ? null : <pre style={codeStyle}>{trace.error}</pre>}
        {trace.validationIssues.length === 0 ? null : (
          <details>
            <summary>Validation issues</summary>
            <pre style={codeStyle}>{trace.validationIssues.join("\n")}</pre>
          </details>
        )}
        {trace.batches.map((batch) => (
          <details key={batch.batch}>
            <summary>
              Batch {batch.batch}: {batch.segmentCount} segments, {batch.sourceCharacters} source characters, approximately{" "}
              {batch.estimatedInputTokens} input tokens
            </summary>
            <div style={{ ...stackStyle, padding: "12px 0 0 16px" }}>
              <small style={mutedStyle}>{batch.segmentLabels.join(", ")}</small>
              {batch.attempts.map((attempt) => (
                <details key={attempt.attempt}>
                  <summary>
                    Attempt {attempt.attempt}: {attempt.error === null ? "completed" : "failed"} in {attempt.durationMs} ms
                  </summary>
                  <div style={{ ...stackStyle, padding: "12px 0 0 16px" }}>
                    <details>
                      <summary>System prompt</summary>
                      <pre style={codeStyle}>{attempt.systemPrompt}</pre>
                    </details>
                    <details>
                      <summary>User prompt</summary>
                      <pre style={codeStyle}>{attempt.userPrompt}</pre>
                    </details>
                    {attempt.response === null ? null : (
                      <details>
                        <summary>Normalized model response</summary>
                        <pre style={codeStyle}>{attempt.response}</pre>
                      </details>
                    )}
                    {attempt.translations === null ? null : (
                      <details>
                        <summary>Parsed translations</summary>
                        <pre style={codeStyle}>{JSON.stringify(attempt.translations, null, 2)}</pre>
                      </details>
                    )}
                    {attempt.error === null ? null : (
                      <details>
                        <summary>Attempt error</summary>
                        <pre style={codeStyle}>{attempt.error}</pre>
                      </details>
                    )}
                  </div>
                </details>
              ))}
            </div>
          </details>
        ))}
      </div>
    </LayerCard>
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
