import { Link } from "@emdash-cms/admin";
import { Badge, Button, LayerCard, Tabs } from "@cloudflare/kumo";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  MAX_BATCH_TRANSLATIONS,
  type BatchJobEntriesResponse,
  type BatchJobOutcome,
  type BatchJobResultsResponse,
  type BatchJobResultView,
  type BatchJobSettings,
  type BatchJobView,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, plural, pluginRequest } from "../../../utils.js";
import { mutedStyle, rowStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { jobSettingsSummary } from "../../../components/JobSettings/JobSettings.js";
import { NewWindowIcon } from "../../../components/NewWindowLink/NewWindowLink.js";
import { TextTooltip, UsageTooltip } from "../../../components/PageHeader/PageHeader.js";
import { TranslationLinks } from "./BatchResults.js";
import { batchJobDone, batchJobFinished, type PublicUrlContext } from "./helpers.js";
import { OutcomeBadge, OutcomeBar, OutcomeCounts, visuallyHiddenStyle } from "./Outcome.js";
import { RetryForm } from "./RetryForm.js";

const MAX_LISTED_LOCALES = 3;

type JobAction = "cancel" | "retry" | "delete";
type RetryOptions = { settings?: BatchJobSettings | null; redo?: boolean };

export function BatchJobs({
  jobs,
  collectionLabels,
  urlContexts,
  onChange,
}: {
  jobs: readonly BatchJobView[];
  /** Collection slug → its label; jobs of other collections show the slug. */
  collectionLabels: Readonly<Record<string, string>>;
  urlContexts: Record<string, PublicUrlContext>;
  onChange(): void;
}): ReactNode {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const seenStatuses = useRef(new Map<string, BatchJobView["status"]>());

  useEffect(() => {
    const changed: string[] = [];
    for (const job of jobs) {
      const previous = seenStatuses.current.get(job.id);
      if (previous !== undefined && previous !== job.status) {
        changed.push(
          `${jobTitle(job, collectionLabels[job.collection] ?? job.collection)}: ${statusText(job, batchJobDone(job)).toLowerCase()}`,
        );
      }
      seenStatuses.current.set(job.id, job.status);
    }
    if (changed.length > 0) setAnnouncement(changed.join(". "));
  }, [jobs, collectionLabels]);

  async function act(jobIds: readonly string[], action: JobAction, key: string, options: RetryOptions = {}): Promise<boolean> {
    setWorking(key);
    setError(null);
    try {
      for (const jobId of jobIds) {
        await pluginRequest(`batch/${action}`, { method: "POST", body: JSON.stringify({ jobId, ...options }) });
      }
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setWorking(null);
      onChange();
    }
  }

  if (jobs.length === 0) return null;
  const removable = jobs.filter(canRemove).map(({ id }) => id);
  return (
    <section style={{ ...stackStyle, marginTop: 24 }}>
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
      <div role="status" aria-live="polite" style={visuallyHiddenStyle}>
        {announcement}
      </div>
      <LayerCard style={{ overflow: "hidden", padding: 0 }}>
        <ul style={listStyle}>
          {jobs.map((job, index) => (
            <JobRow
              key={job.id}
              job={job}
              last={index === jobs.length - 1}
              label={collectionLabels[job.collection] ?? job.collection}
              urlContext={urlContexts[job.collection]}
              retriedJob={job.retryOf === null ? undefined : jobs.find(({ id }) => id === job.retryOf)}
              working={working}
              act={act}
            />
          ))}
        </ul>
      </LayerCard>
    </section>
  );
}

function JobRow({
  job,
  last,
  label,
  urlContext,
  retriedJob,
  working,
  act,
}: {
  job: BatchJobView;
  last: boolean;
  label: string;
  urlContext: PublicUrlContext | undefined;
  /** The job this one retried, while it's still listed. */
  retriedJob: BatchJobView | undefined;
  working: string | null;
  act(jobIds: readonly string[], action: JobAction, key: string, options?: RetryOptions): Promise<boolean>;
}): ReactNode {
  const [open, setOpen] = useState(job.status === "running");
  const [retrying, setRetrying] = useState(false);
  const bodyId = useId();
  const done = batchJobDone(job);
  const finished = batchJobFinished(job);
  const title = jobTitle(job, label);
  const localeNames = job.locales.map((locale) => localeLabel(locale)).join(", ");
  const written = job.counts.created + job.counts.updated;
  // A cancel drops queued translations without a result; a selected-entries retry queues them again.
  const notRun = job.status === "cancelled" && typeof job.entryCount === "number" ? Math.max(0, job.total - done) : 0;
  const settingsSummary = jobSettingsSummary(job.settings);
  const canRetry = (finished || job.status === "cancelled") && (job.counts.failed > 0 || notRun > 0 || written > 0 || job.listing);

  return (
    <li style={last ? undefined : itemStyle}>
      <div style={headerStyle}>
        <Button
          variant="ghost"
          shape="square"
          size="sm"
          icon={open ? CaretDownIcon : CaretRightIcon}
          aria-label={`Details for ${title}`}
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen(!open)}
        />
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <div style={rowStyle}>
            <strong>{title}</strong>
            <StatusBadge job={job} done={done} />
          </div>
          <small style={{ ...mutedStyle, ...rowStyle, columnGap: 6, rowGap: 2 }}>
            {/* Each separator sits inside the item before it, so a wrapped line never starts with one. */}
            {[
              job.locales.length > MAX_LISTED_LOCALES ? (
                <TextTooltip content={localeNames} label={`${plural(job.locales.length, "locale")}: ${localeNames}`}>
                  {plural(job.locales.length, "locale")}
                </TextTooltip>
              ) : (
                localeNames
              ),
              job.entryCount === "all"
                ? "Whole collection"
                : typeof job.entryCount === "number"
                  ? plural(job.entryCount, "entry", "entries")
                  : "Entries not recorded",
              <TextTooltip
                content={
                  job.publish ? "Each translation is published as soon as it's saved." : "Translations are saved as drafts to review."
                }
              >
                {job.publish ? "Publishing" : "Drafts"}
              </TextTooltip>,
              job.updateExisting ? (
                <TextTooltip content="Existing translations are translated again. Ones edited while the job runs are skipped.">
                  Updating existing
                </TextTooltip>
              ) : null,
              job.retryOf === null ? null : retriedJob === undefined ? "Retry" : `Retry of ${startedAt(retriedJob.createdAt)}`,
              settingsSummary === null ? null : (
                <TextTooltip content={job.settings?.instructions ? `${settingsSummary}: ${job.settings.instructions}` : settingsSummary}>
                  Run settings
                </TextTooltip>
              ),
            ]
              .filter((item) => item !== null)
              .map((item, index, items) => (
                <span key={index}>
                  {item}
                  {index < items.length - 1 ? <span aria-hidden="true"> ·</span> : null}
                </span>
              ))}
          </small>
        </div>
        <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
          <OutcomeBar counts={job.counts} total={job.total} width={72} />
          <small style={mutedStyle}>
            <UsageTooltip usage={job.usage}>{`${done}/${job.total}${job.listing ? "+" : ""}`}</UsageTooltip>
          </small>
        </div>
      </div>
      {open ? (
        <div id={bodyId} style={bodyStyle}>
          <OutcomeCounts counts={job.counts} />
          {job.listing ? <small style={mutedStyle}>Still listing the collection's entries, so the total can still grow.</small> : null}
          {job.truncated ? (
            <small style={mutedStyle}>
              Stopped at {MAX_BATCH_TRANSLATIONS.toLocaleString()} translations, the most one job holds. Later entries in the collection
              were not queued; select them and start another job.
            </small>
          ) : null}
          {job.status === "cancelled" && done < job.total ? (
            <small style={mutedStyle}>
              {job.entryCount === "all" || job.listing
                ? "The job was cancelled, so some translations didn't finish. Retry lists the rest of the collection, but entries already listed when it was cancelled need another whole-collection job."
                : `${job.total - done} of ${job.total} translations didn't finish because the job was cancelled. Retry runs them.`}
            </small>
          ) : null}
          <JobTabs job={job} done={done} urlContext={urlContext} />
          <div style={rowStyle}>
            {job.status === "running" ? (
              <Button
                size="sm"
                variant="secondary"
                loading={working === job.id}
                aria-label={`Cancel ${title}`}
                onClick={() => void act([job.id], "cancel", job.id)}
              >
                Cancel
              </Button>
            ) : null}
            {canRetry && !retrying ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={working !== null}
                aria-label={`Retry ${title}`}
                onClick={() => setRetrying(true)}
              >
                Retry
              </Button>
            ) : null}
            {canRemove(job) ? (
              <Button
                size="sm"
                variant="ghost"
                loading={working === job.id}
                aria-label={`Remove ${title}`}
                onClick={() => void act([job.id], "delete", job.id)}
              >
                Remove
              </Button>
            ) : null}
          </div>
          {retrying ? (
            <RetryForm
              failed={job.counts.failed}
              notRun={notRun}
              moreToList={job.listing}
              written={written}
              initialSettings={job.settings}
              working={working === job.id}
              blocked={working !== null}
              onRetry={(settings, redo) =>
                void act([job.id], "retry", job.id, { settings, redo }).then((retried) => {
                  if (retried) setRetrying(false);
                })
              }
              onCancel={() => setRetrying(false)}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function statusText(job: BatchJobView, done: number): string {
  if (job.status === "running") return job.listing ? "Running, listing entries" : "Running";
  const failed = job.counts.failed > 0 ? `, ${job.counts.failed} failed` : "";
  if (job.status === "cancelled") return `Cancelled${done < job.total ? `, ${job.total - done} unfinished` : ""}${failed}`;
  return `Finished${failed}`;
}

function StatusBadge({ job, done }: { job: BatchJobView; done: number }): ReactNode {
  const variant =
    job.status === "cancelled" ? "secondary" : job.status === "running" ? "info" : job.counts.failed > 0 ? "warning" : "success";
  const status = <Badge variant={variant}>{statusText(job, done)}</Badge>;
  return job.truncated ? (
    <>
      {status}
      <Badge variant="warning">Stopped at {MAX_BATCH_TRANSLATIONS.toLocaleString()}</Badge>
    </>
  ) : (
    status
  );
}

type JobTab = "entries" | "results" | "failures";
const TAB_NAMES: Record<JobTab, string> = { entries: "Entries", results: "Results", failures: "Failures" };

function JobTabs({ job, done, urlContext }: { job: BatchJobView; done: number; urlContext: PublicUrlContext | undefined }): ReactNode {
  const tabs: Array<{ value: JobTab; label: string }> = [
    ...(typeof job.entryCount === "number" ? [{ value: "entries" as const, label: `Entries (${job.entryCount})` }] : []),
    ...(done === 0 ? [] : [{ value: "results" as const, label: `Results (${done})` }]),
    ...(job.counts.failed === 0 ? [] : [{ value: "failures" as const, label: `Failures (${job.counts.failed})` }]),
  ];
  const [chosen, setChosen] = useState<JobTab | null>(null);
  const active = tabs.find((tab) => tab.value === chosen)?.value ?? tabs[0]?.value;
  if (active === undefined) return null;
  return (
    <div style={stackStyle}>
      <Tabs
        variant="underline"
        tabs={tabs}
        value={active}
        onValueChange={(value) => {
          if (value === "entries" || value === "results" || value === "failures") setChosen(value);
        }}
      />
      <div role="tabpanel" aria-label={TAB_NAMES[active]}>
        {active === "entries" ? <JobEntries job={job} /> : null}
        {active === "results" ? <JobResults job={job} progress={done} urlContext={urlContext} /> : null}
        {active === "failures" ? <JobResults job={job} progress={job.counts.failed} urlContext={urlContext} outcome="failed" /> : null}
      </div>
    </div>
  );
}

/** Loads on mount, and again as `progress` grows while the tab stays open. `outcome` keeps only those rows. */
function JobResults({
  job,
  progress,
  urlContext,
  outcome,
}: {
  job: BatchJobView;
  progress: number;
  urlContext: PublicUrlContext | undefined;
  outcome?: BatchJobOutcome | undefined;
}): ReactNode {
  const [results, setResults] = useState<BatchJobResultView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Once Load more is used, progress stops reloading the first page, so the loaded pages stay; Refresh starts over.
  const [paged, setPaged] = useState(false);
  const [refreshes, setRefreshes] = useState(0);

  useEffect(() => {
    if (paged) return;
    let active = true;
    loadJobResults(job.id, null, outcome)
      .then((page) => {
        if (!active) return;
        setResults(page.results);
        setNextCursor(page.nextCursor);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [job.id, progress, outcome, paged, refreshes]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setPaged(true);
    try {
      const page = await loadJobResults(job.id, nextCursor, outcome);
      setResults((current) => [...(current ?? []), ...page.results]);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div style={stackStyle}>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {results === null ? (
        <span style={mutedStyle}>Loading results...</span>
      ) : (
        <ul style={{ ...listStyle, gap: 10 }}>
          {results.map((row) => (
            <li key={`${row.entryId}:${row.locale}`} style={{ display: "grid", gap: 2 }}>
              <div style={{ ...rowStyle, gap: 8 }}>
                <OutcomeBadge outcome={row.outcome} />
                <span>{localeLabel(row.locale)}</span>
                {job.entryCount === 1 ? null : <small style={mutedStyle}>{row.title}</small>}
              </div>
              {row.message === null ? null : <small style={mutedStyle}>{row.message}</small>}
              {row.translation === null ? (
                <Link
                  to="/content/$collection/$id"
                  params={{ collection: job.collection, id: row.entryId }}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Edit source entry ${row.title}`}
                >
                  Edit source
                  <NewWindowIcon />
                </Link>
              ) : (
                <TranslationLinks
                  collection={job.collection}
                  translation={row.translation}
                  urlContext={urlContext}
                  label={`${row.title}, ${localeLabel(row.locale)}`}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <div style={rowStyle}>
        {nextCursor === null ? null : (
          <Button size="sm" variant="secondary" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        )}
        {paged ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={loadingMore}
            onClick={() => {
              setPaged(false);
              setRefreshes((current) => current + 1);
            }}
          >
            Refresh
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The job's selected source entries, each opening in the editor in a new tab. */
function JobEntries({ job }: { job: BatchJobView }): ReactNode {
  const [entries, setEntries] = useState<BatchJobEntriesResponse["entries"] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    loadJobEntries(job.id, null)
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
  }, [job.id]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadJobEntries(job.id, nextCursor);
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div style={stackStyle}>
      {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
      {entries === null ? (
        <span style={mutedStyle}>Loading entries...</span>
      ) : (
        <ul style={{ ...listStyle, gap: 4 }}>
          {entries.map((entry) => (
            <li key={entry.id}>
              {entry.deleted ? (
                <span style={mutedStyle}>{entry.title} (deleted)</span>
              ) : (
                <Link
                  to="/content/$collection/$id"
                  params={{ collection: job.collection, id: entry.id }}
                  search={entry.locale === null ? {} : { locale: entry.locale }}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {entry.title}
                  <NewWindowIcon />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor === null ? null : (
        <div>
          <Button size="sm" variant="secondary" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function jobTitle(job: BatchJobView, label: string): string {
  return `${label} · ${startedAt(job.createdAt)}`;
}

function startedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function loadJobEntries(jobId: string, cursor: string | null): Promise<BatchJobEntriesResponse> {
  const query = new URLSearchParams({ jobId, ...(cursor === null ? {} : { cursor }) });
  return pluginRequest<BatchJobEntriesResponse>(`batch/entries?${query.toString()}`);
}

function loadJobResults(jobId: string, cursor: string | null, outcome: BatchJobOutcome | undefined): Promise<BatchJobResultsResponse> {
  const query = new URLSearchParams({ jobId, ...(cursor === null ? {} : { cursor }), ...(outcome === undefined ? {} : { outcome }) });
  return pluginRequest<BatchJobResultsResponse>(`batch/results?${query.toString()}`);
}

function canRemove(job: BatchJobView): boolean {
  return job.status === "cancelled" || batchJobFinished(job);
}

const listStyle: CSSProperties = { display: "grid", listStyle: "none", margin: 0, padding: 0 };
const itemStyle: CSSProperties = { borderBottom: "1px solid var(--color-kumo-line, #ececef)" };
const headerStyle: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: 10,
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  padding: 16,
};
// Lines up with the title: padding, the 28px caret button and the gap.
const bodyStyle: CSSProperties = { ...stackStyle, padding: "0 16px 16px 54px" };
