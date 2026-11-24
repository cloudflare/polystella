import { Button, LayerCard, Table } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import {
  MAX_BATCH_TRANSLATIONS,
  type BatchJobEntriesResponse,
  type BatchJobResultsResponse,
  type BatchJobResultView,
  type BatchJobView,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, pluginRequest } from "../../../utils.js";
import { cardStyle, mutedStyle, rowStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { TranslationProgress } from "../../../components/TranslationProgress/TranslationProgress.js";
import { BatchResultsTable } from "./BatchResults.js";
import { batchJobDone, batchJobFinished, type PublicUrlContext } from "./helpers.js";

export function BatchJobs({
  jobs,
  urlContexts,
  onChange,
}: {
  jobs: readonly BatchJobView[];
  urlContexts: Record<string, PublicUrlContext>;
  onChange(): void;
}): ReactNode {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(jobIds: readonly string[], action: "cancel" | "retry" | "delete", key: string): Promise<void> {
    setWorking(key);
    setError(null);
    try {
      for (const jobId of jobIds) {
        await pluginRequest(`batch/${action}`, { method: "POST", body: JSON.stringify({ jobId }) });
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(null);
      onChange();
    }
  }

  if (jobs.length === 0) return null;
  const removable = jobs.filter(canRemove).map(({ id }) => id);
  return (
    <section style={stackStyle}>
      <div style={rowStyle}>
        <h3>Server jobs</h3>
        {removable.length === 0 ? null : (
          <Button
            size="sm"
            variant="secondary"
            loading={working === "clear"}
            disabled={working !== null}
            onClick={() => {
              if (window.confirm(`Remove ${removable.length} finished or cancelled jobs from this list? Translations they created stay.`)) {
                void act(removable, "delete", "clear");
              }
            }}
          >
            Clear finished jobs
          </Button>
        )}
      </div>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {jobs.map((job) => {
        const done = batchJobDone(job);
        const finished = batchJobFinished(job);
        const state = job.status === "cancelled" ? "Cancelled" : finished ? "Finished" : "Running";
        return (
          <LayerCard key={job.id} style={cardStyle}>
            <div style={stackStyle}>
              <span>
                <strong>{job.collection}</strong> → {job.locales.map((locale) => localeLabel(locale)).join(", ")}{" "}
                <small style={mutedStyle}>
                  {state},{" "}
                  {job.entryCount === "all"
                    ? "whole collection"
                    : typeof job.entryCount === "number"
                      ? `${job.entryCount} selected entries`
                      : "entries not recorded"}
                  , {job.publish ? "publishing" : "as drafts"}, started {job.createdAt}
                </small>
              </span>
              <TranslationProgress
                percent={job.total === 0 ? 0 : Math.round((done / job.total) * 100)}
                label={`${done}/${job.total}${job.listing ? " so far, still listing entries" : ""}: ${job.counts.created} created, ${job.counts.skipped} skipped, ${job.counts.failed} failed`}
              />
              {job.truncated ? (
                <small style={mutedStyle}>
                  Stopped at {MAX_BATCH_TRANSLATIONS.toLocaleString()} translations, the most one job holds. Later entries in the collection
                  were not queued; select them and start another job.
                </small>
              ) : null}
              {typeof job.entryCount === "number" ? <JobEntries jobId={job.id} count={job.entryCount} /> : null}
              {done === 0 ? null : <JobResults job={job} done={done} urlContext={urlContexts[job.collection]} />}
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
                          <Table.Cell>{localeLabel(failure.locale)}</Table.Cell>
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
                  <Button size="sm" variant="secondary" loading={working === job.id} onClick={() => void act([job.id], "cancel", job.id)}>
                    Cancel
                  </Button>
                ) : null}
                {job.counts.failed > 0 && (finished || job.status === "cancelled") ? (
                  <Button size="sm" variant="secondary" loading={working === job.id} onClick={() => void act([job.id], "retry", job.id)}>
                    Retry {job.counts.failed} failed
                  </Button>
                ) : null}
                {canRemove(job) ? (
                  <Button size="sm" variant="ghost" loading={working === job.id} onClick={() => void act([job.id], "delete", job.id)}>
                    Remove
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

/** Loads when opened, and again as the job progresses while it stays open. */
function JobResults({ job, done, urlContext }: { job: BatchJobView; done: number; urlContext: PublicUrlContext | undefined }): ReactNode {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<BatchJobResultView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    loadJobResults(job.id, null)
      .then((page) => {
        if (!active) return;
        setResults(page.results);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [open, job.id, done]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await loadJobResults(job.id, nextCursor);
      setResults((current) => [...(current ?? []), ...page.results]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Show results</summary>
      <div style={stackStyle}>
        {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
        {results === null ? (
          <span style={mutedStyle}>Loading results...</span>
        ) : (
          <BatchResultsTable
            collection={job.collection}
            urlContext={urlContext}
            rows={results.map((row) => ({ key: `${row.entryId}:${row.locale}`, ...row }))}
          />
        )}
        {nextCursor === null ? null : (
          <div>
            <Button size="sm" variant="secondary" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

/** Loads the job's selected source entries when opened. */
function JobEntries({ jobId, count }: { jobId: string; count: number }): ReactNode {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<BatchJobEntriesResponse["entries"] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || entries !== null) return;
    let active = true;
    loadJobEntries(jobId, null)
      .then((page) => {
        if (!active) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [open, jobId, entries]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await loadJobEntries(jobId, nextCursor);
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Show entries ({count})</summary>
      <div style={stackStyle}>
        {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
        {entries === null ? (
          <span style={mutedStyle}>Loading entries...</span>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.id}>{entry.title}</li>
            ))}
          </ul>
        )}
        {nextCursor === null ? null : (
          <div>
            <Button size="sm" variant="secondary" onClick={() => void loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

function loadJobEntries(jobId: string, cursor: string | null): Promise<BatchJobEntriesResponse> {
  const query = new URLSearchParams({ jobId, ...(cursor === null ? {} : { cursor }) });
  return pluginRequest<BatchJobEntriesResponse>(`batch/entries?${query.toString()}`);
}

function loadJobResults(jobId: string, cursor: string | null): Promise<BatchJobResultsResponse> {
  const query = new URLSearchParams({ jobId, ...(cursor === null ? {} : { cursor }) });
  return pluginRequest<BatchJobResultsResponse>(`batch/results?${query.toString()}`);
}

function canRemove(job: BatchJobView): boolean {
  return job.status === "cancelled" || batchJobFinished(job);
}
