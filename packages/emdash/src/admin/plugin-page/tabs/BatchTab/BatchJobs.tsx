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
  type BatchJobView,
} from "../../../../contracts.js";
import { errorMessage, localeLabel, plural, pluginRequest } from "../../../utils.js";
import { mutedStyle, rowStyle, stackStyle } from "../../../styles.js";
import { ErrorMessage } from "../../../components/ErrorMessage/ErrorMessage.js";
import { NewWindowIcon } from "../../../components/NewWindowLink/NewWindowLink.js";
import { TextTooltip } from "../../../components/PageHeader/PageHeader.js";
import { TranslationLinks } from "./BatchResults.js";
import { batchJobDone, batchJobFinished, type PublicUrlContext } from "./helpers.js";

const MAX_LISTED_LOCALES = 3;

const OUTCOMES: ReadonlyArray<{ outcome: BatchJobOutcome; color: string; info: string }> = [
  { outcome: "created", color: "var(--color-kumo-success, #1e8e3e)", info: "New translations this job saved." },
  { outcome: "updated", color: "var(--color-kumo-badge-purple, #8e4ec6)", info: "Existing translations this job translated again." },
  {
    outcome: "skipped",
    color: "var(--color-kumo-badge-neutral, #a3a3a8)",
    info: "Already translated, or edited while the job ran. Nothing was changed.",
  },
  { outcome: "failed", color: "var(--color-kumo-danger, #d93025)", info: "Results says why. Retry failed runs them again." },
];

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
      <LayerCard style={{ overflow: "hidden", padding: 0 }}>
        <ul style={listStyle}>
          {jobs.map((job, index) => (
            <JobRow
              key={job.id}
              job={job}
              last={index === jobs.length - 1}
              label={collectionLabels[job.collection] ?? job.collection}
              urlContext={urlContexts[job.collection]}
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
  working,
  act,
}: {
  job: BatchJobView;
  last: boolean;
  label: string;
  urlContext: PublicUrlContext | undefined;
  working: string | null;
  act(jobIds: readonly string[], action: "cancel" | "retry" | "delete", key: string): Promise<void>;
}): ReactNode {
  const [open, setOpen] = useState(job.status === "running");
  const bodyId = useId();
  const done = batchJobDone(job);
  const finished = batchJobFinished(job);
  const title = `${label} · ${startedAt(job.createdAt)}`;
  const localeNames = job.locales.map((locale) => localeLabel(locale)).join(", ");

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
            {job.locales.length > MAX_LISTED_LOCALES ? (
              <TextTooltip content={localeNames} label={`${plural(job.locales.length, "locale")}: ${localeNames}`}>
                {plural(job.locales.length, "locale")}
              </TextTooltip>
            ) : (
              <span>{localeNames}</span>
            )}
            <span aria-hidden="true">·</span>
            <span>
              {job.entryCount === "all"
                ? "Whole collection"
                : typeof job.entryCount === "number"
                  ? plural(job.entryCount, "entry", "entries")
                  : "Entries not recorded"}
            </span>
            <span aria-hidden="true">·</span>
            <TextTooltip
              content={job.publish ? "Each translation is published as soon as it's saved." : "Translations are saved as drafts to review."}
            >
              {job.publish ? "Publishing" : "Drafts"}
            </TextTooltip>
            {job.updateExisting ? (
              <>
                <span aria-hidden="true">·</span>
                <TextTooltip content="Existing translations are translated again. Ones edited while the job runs are skipped.">
                  Updating existing
                </TextTooltip>
              </>
            ) : null}
          </small>
        </div>
        <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
          <OutcomeBar job={job} done={done} width={72} />
          <small style={mutedStyle}>
            {done}/{job.total}
            {job.listing ? "+" : ""}
          </small>
        </div>
      </div>
      {open ? (
        <div id={bodyId} style={bodyStyle}>
          <div style={{ ...rowStyle, columnGap: 14, rowGap: 4 }}>
            {OUTCOMES.map(({ outcome, color, info }) => (
              <small key={outcome} style={{ alignItems: "center", display: "inline-flex", gap: 6 }}>
                <span aria-hidden="true" style={{ ...dotStyle, background: color }} />
                <TextTooltip content={info}>{`${job.counts[outcome]} ${outcome}`}</TextTooltip>
              </small>
            ))}
          </div>
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
                ? "The job was cancelled, so some translations didn't finish. Start another whole-collection job to finish them."
                : `${job.total - done} of ${job.total} translations didn't finish because the job was cancelled. Start another job for those entries and locales to finish them.`}
            </small>
          ) : null}
          <JobTabs job={job} done={done} urlContext={urlContext} />
          <div style={rowStyle}>
            {job.status === "running" ? (
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
      ) : null}
    </li>
  );
}

function StatusBadge({ job, done }: { job: BatchJobView; done: number }): ReactNode {
  const status =
    job.status === "cancelled" ? (
      <Badge variant="secondary">{done < job.total ? `Cancelled, ${job.total - done} unfinished` : "Cancelled"}</Badge>
    ) : job.status === "running" ? (
      <Badge variant="info">{job.listing ? "Running, listing entries" : "Running"}</Badge>
    ) : job.counts.failed > 0 ? (
      <Badge variant="warning">Finished, {job.counts.failed} failed</Badge>
    ) : (
      <Badge variant="success">Finished</Badge>
    );
  return job.truncated ? (
    <>
      {status}
      <Badge variant="warning">Stopped at {MAX_BATCH_TRANSLATIONS.toLocaleString()}</Badge>
    </>
  ) : (
    status
  );
}

/** One bar split by outcome; the rest of the track is work still to do. */
function OutcomeBar({ job, done, width }: { job: BatchJobView; done: number; width: number }): ReactNode {
  const total = Math.max(job.total, done, 1);
  const summary = OUTCOMES.map(({ outcome }) => `${job.counts[outcome]} ${outcome}`).join(", ");
  return (
    <div role="img" aria-label={`${done} of ${job.total} done: ${summary}`} style={{ ...barStyle, width }}>
      {OUTCOMES.map(({ outcome, color }) =>
        job.counts[outcome] === 0 ? null : (
          <span key={outcome} style={{ background: color, width: `${(job.counts[outcome] / total) * 100}%` }} />
        ),
      )}
    </div>
  );
}

type JobTab = "entries" | "results" | "failures";
const TAB_NAMES: Record<JobTab, string> = { entries: "Entries", results: "Results", failures: "Failures" };

function JobTabs({ job, done, urlContext }: { job: BatchJobView; done: number; urlContext: PublicUrlContext | undefined }): ReactNode {
  const tabs: Array<{ value: JobTab; label: string }> = [
    ...(typeof job.entryCount === "number" ? [{ value: "entries" as const, label: `Entries (${job.entryCount})` }] : []),
    ...(done === 0 ? [] : [{ value: "results" as const, label: `Results (${done})` }]),
    ...(job.failures.length === 0 ? [] : [{ value: "failures" as const, label: `Failures (${job.counts.failed})` }]),
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
        {active === "results" ? <JobResults job={job} done={done} urlContext={urlContext} /> : null}
        {active === "failures" ? <JobFailures job={job} /> : null}
      </div>
    </div>
  );
}

/** Loads on mount, and again as the job progresses while the tab stays open. */
function JobResults({ job, done, urlContext }: { job: BatchJobView; done: number; urlContext: PublicUrlContext | undefined }): ReactNode {
  const [results, setResults] = useState<BatchJobResultView[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Once Load more is used, progress stops reloading the first page, so the loaded pages stay.
  const pagedRef = useRef(false);

  useEffect(() => {
    if (pagedRef.current) return;
    let active = true;
    loadJobResults(job.id, null)
      .then((page) => {
        if (!active || pagedRef.current) return;
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
  }, [job.id, done]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    pagedRef.current = true;
    try {
      const page = await loadJobResults(job.id, nextCursor);
      setResults((current) => [...(current ?? []), ...page.results]);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
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
              {row.translation === null ? null : (
                <TranslationLinks collection={job.collection} translation={row.translation} urlContext={urlContext} />
              )}
            </li>
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
  );
}

function OutcomeBadge({ outcome }: { outcome: BatchJobOutcome }): ReactNode {
  const variant = outcome === "created" ? "success" : outcome === "updated" ? "purple" : outcome === "failed" ? "error" : "secondary";
  return <Badge variant={variant}>{outcome.charAt(0).toUpperCase() + outcome.slice(1)}</Badge>;
}

/** The job's selected source entries, each opening in the editor in a new tab. */
function JobEntries({ job }: { job: BatchJobView }): ReactNode {
  const [entries, setEntries] = useState<BatchJobEntriesResponse["entries"] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (nextCursor === null) return;
    try {
      const page = await loadJobEntries(job.id, nextCursor);
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
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
          <Button size="sm" variant="secondary" onClick={() => void loadMore()}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function JobFailures({ job }: { job: BatchJobView }): ReactNode {
  return (
    <div style={stackStyle}>
      {job.failures.length < job.counts.failed ? (
        <small style={mutedStyle}>
          Showing the first {job.failures.length} of {job.counts.failed}. Results lists every row with its entry title.
        </small>
      ) : null}
      <ul style={{ ...listStyle, gap: 10 }}>
        {job.failures.map((failure) => (
          <li key={`${failure.entryId}:${failure.locale}`} style={{ display: "grid", gap: 2 }}>
            <div style={{ ...rowStyle, gap: 8 }}>
              <span>{localeLabel(failure.locale)}</span>
              <code style={{ fontSize: 12 }}>{failure.entryId}</code>
            </div>
            {failure.message === null ? null : <small style={mutedStyle}>{failure.message}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function startedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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

const listStyle: CSSProperties = { display: "grid", listStyle: "none", margin: 0, padding: 0 };
const itemStyle: CSSProperties = { borderBottom: "1px solid var(--color-kumo-line, #ececef)" };
const headerStyle: CSSProperties = {
  alignItems: "center",
  display: "grid",
  gap: 10,
  gridTemplateColumns: "auto minmax(0, 1fr) auto",
  padding: "10px 12px",
};
const bodyStyle: CSSProperties = { ...stackStyle, padding: "0 12px 14px 50px" };
const barStyle: CSSProperties = {
  background: "var(--color-kumo-fill, #e9e9ec)",
  borderRadius: 999,
  display: "flex",
  height: 6,
  overflow: "hidden",
};
const dotStyle: CSSProperties = { borderRadius: "50%", display: "inline-block", height: 8, width: 8 };
