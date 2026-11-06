import { Button, LayerCard, Table } from "@cloudflare/kumo";
import { useState, type ReactNode } from "react";

import type { BatchJobView } from "../../../../contracts.js";
import { errorMessage, pluginRequest } from "../../../utils.js";
import { cardStyle, mutedStyle, rowStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { TranslationProgress } from "../../../components/TranslationProgress/TranslationProgress.js";
import { batchJobDone, batchJobFinished } from "./helpers.js";

export function BatchJobs({ jobs, onChange }: { jobs: readonly BatchJobView[]; onChange(): void }): ReactNode {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(jobId: string, action: "cancel" | "retry"): Promise<void> {
    setWorking(jobId);
    setError(null);
    try {
      await pluginRequest<BatchJobView>(`batch/${action}`, { method: "POST", body: JSON.stringify({ jobId }) });
      onChange();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(null);
    }
  }

  if (jobs.length === 0) return null;
  return (
    <section style={stackStyle}>
      <h3>Server jobs</h3>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {jobs.map((job) => {
        const done = batchJobDone(job);
        const finished = batchJobFinished(job);
        const state = job.status === "cancelled" ? "Cancelled" : finished ? "Finished" : "Running";
        return (
          <LayerCard key={job.id} style={cardStyle}>
            <div style={stackStyle}>
              <span>
                <strong>{job.collection}</strong> → {job.locales.join(", ")}{" "}
                <small style={mutedStyle}>
                  {state}, started {job.createdAt}
                </small>
              </span>
              <TranslationProgress
                percent={Math.round((done / job.total) * 100)}
                label={`${done}/${job.total}: ${job.counts.created} created, ${job.counts.skipped} skipped, ${job.counts.failed} failed`}
              />
              {job.failures.length === 0 ? null : (
                <details>
                  <summary>Show failures</summary>
                  <Table layout="fixed">
                    <Table.Header>
                      <Table.Row>
                        <Table.Head style={{ width: "30%" }}>Entry ID</Table.Head>
                        <Table.Head style={{ width: "15%" }}>Locale</Table.Head>
                        <Table.Head>Details</Table.Head>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {job.failures.map((failure) => (
                        <Table.Row key={`${failure.entryId}:${failure.locale}`}>
                          <Table.Cell>
                            <code>{failure.entryId}</code>
                          </Table.Cell>
                          <Table.Cell>{failure.locale}</Table.Cell>
                          <Table.Cell>
                            <span style={mutedStyle}>{failure.message ?? ""}</span>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table>
                </details>
              )}
              <div style={rowStyle}>
                {job.status === "running" && !finished ? (
                  <Button size="sm" variant="secondary" loading={working === job.id} onClick={() => void act(job.id, "cancel")}>
                    Cancel
                  </Button>
                ) : null}
                {job.counts.failed > 0 && (finished || job.status === "cancelled") ? (
                  <Button size="sm" variant="secondary" loading={working === job.id} onClick={() => void act(job.id, "retry")}>
                    Retry {job.counts.failed} failed
                  </Button>
                ) : null}
              </div>
            </div>
          </LayerCard>
        );
      })}
    </section>
  );
}
