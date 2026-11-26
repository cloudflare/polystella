import { Banner, Button, LayerCard } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage, localeLabel, plural, pluginPageUrl, rememberLocaleTags } from "../utils.js";
import { PageTitle, SectionHeader } from "../components/PageHeader/PageHeader.js";
import { cardStyle, mutedStyle, pageStyle, rowStyle, sectionStyle, stackStyle } from "../styles.js";
import type { BatchJobSettings } from "../../contracts.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";
import { jobSettingsSummary } from "../components/JobSettings/JobSettings.js";
import { TranslationProgress } from "../components/TranslationProgress/TranslationProgress.js";
import { BatchResultsTable, usePublicUrlContexts } from "./tabs/BatchTab/BatchResults.js";
import { RetryForm } from "./tabs/BatchTab/RetryForm.js";
import {
  clearBatchRun,
  loadAllItems,
  planBatchJobs,
  readBatchRun,
  runBatchJob,
  runBatchJobs,
  type BatchItem,
  type BatchJob,
  type BatchResult,
  type BatchRunPlan,
} from "./tabs/BatchTab/helpers.js";

const CONCURRENCY = 3;

function isWritten(result: BatchResult): boolean {
  return (result.outcome === "created" || result.outcome === "updated") && result.translation !== null;
}

/** A browser batch run in its own tab, opened from the Batch translation page. */
export function BatchRunPage(): ReactNode {
  const [runId] = useState(() => new URLSearchParams(window.location.search).get("run"));
  const [plan] = useState<BatchRunPlan | null>(() => {
    const stored = runId === null ? null : readBatchRun(runId);
    rememberLocaleTags(stored?.localeTags);
    return stored;
  });
  const [items, setItems] = useState<BatchItem[] | null>(plan?.scope === "selected" ? plan.items : null);
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<BatchJobSettings | null>(plan?.options.settings ?? null);
  const [retrying, setRetrying] = useState(false);
  const stopRequested = useRef(false);
  const urlContexts = usePublicUrlContexts();

  useEffect(() => {
    if (plan === null || plan.scope !== "all") return;
    const { sourceLocale } = plan.options;
    if (sourceLocale === undefined) {
      setError("PolyStella could not tell which locale holds the source entries. Reload the Batch translation page and start again.");
      return;
    }
    let active = true;
    loadAllItems(plan.collection, sourceLocale, plan.targets)
      .then((loaded) => {
        if (active) setItems(loaded);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [plan]);

  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  async function run(jobs: readonly BatchJob[], runSettings: BatchJobSettings | null): Promise<void> {
    if (plan === null) return;
    setError(null);
    setRunning(true);
    stopRequested.current = false;
    setStopping(false);
    try {
      await runBatchJobs(
        jobs,
        CONCURRENCY,
        async (job) => {
          const result = await runBatchJob(job, { ...plan.options, settings: runSettings });
          setResults((current) => [...current, result]);
        },
        () => stopRequested.current,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunning(false);
      setStopping(false);
    }
  }

  function start(): void {
    if (plan === null || runId === null || items === null) return;
    const jobs = planBatchJobs(items, plan.targets);
    // A reload must not silently start the same run again.
    clearBatchRun(runId);
    setStarted(true);
    setTotal(jobs.length);
    void run(jobs, settings);
  }

  function retry(retrySettings: BatchJobSettings | null, redo: boolean): void {
    const retried = results.filter((result) => result.outcome === "failed" || (redo && isWritten(result)));
    const jobs = retried.map(({ item, target, outcome, translation }) => ({
      item,
      target,
      ...(outcome === "failed" || translation === null ? {} : { redo: translation }),
    }));
    // Retried rows leave the table and come back with their new outcome, so the run total stays the same.
    setResults((current) => current.filter((result) => !retried.includes(result)));
    setSettings(retrySettings);
    setRetrying(false);
    void run(jobs, retrySettings);
  }

  if (plan === null) {
    return (
      <main style={pageStyle}>
        <PageTitle>PolyStella</PageTitle>
        <SectionHeader
          title="Batch run"
          description={
            <>
              This run was already started or has expired. Start a new one from{" "}
              <a href={pluginPageUrl("/batch-translation")}>Batch translation</a>.
            </>
          }
        />
      </main>
    );
  }

  const failed = results.filter((result) => result.outcome === "failed").length;
  const written = results.filter(isWritten).length;
  const finished = started && !running;
  const action = `${plan.options.updateExisting ? "Create missing translations and update existing ones" : "Create missing translations, skipping existing ones"}, ${plan.options.publish ? "and publish them" : "as drafts"}.`;
  const settingsSummary = jobSettingsSummary(settings);

  return (
    <main style={pageStyle}>
      <PageTitle>PolyStella</PageTitle>
      <section style={sectionStyle}>
        <SectionHeader title="Batch run" />
        <Banner
          variant={finished ? "secondary" : "alert"}
          title={finished ? "This run has finished" : "Keep this tab open"}
          description={
            finished
              ? "You can close this tab. The translations are saved."
              : "The translations run in this browser tab. Closing it, reloading it, or leaving this page stops the run after the translations in progress."
          }
        />
        {error === null ? null : <ErrorMessage>{error}</ErrorMessage>}
        <LayerCard style={cardStyle}>
          <div style={stackStyle}>
            <span>
              <strong>{plan.collection}</strong> → {plan.targets.map(({ locale, code }) => localeLabel(locale, code)).join(", ")}
            </span>
            <span style={mutedStyle}>
              {items === null
                ? "Loading source entries..."
                : `${plural(items.length, "entry", "entries")} × ${plural(plan.targets.length, "locale")} = ${plural(items.length * plan.targets.length, "translation")}.`}{" "}
              {action}
              {settingsSummary === null ? null : ` Settings: ${settingsSummary}.`}
            </span>
            {started ? null : (
              <div>
                <Button variant="primary" disabled={items === null || items.length === 0} onClick={start}>
                  Start translating
                </Button>
              </div>
            )}
          </div>
        </LayerCard>
        {started ? (
          <div style={rowStyle}>
            {running ? (
              <Button
                variant="secondary"
                disabled={stopping}
                onClick={() => {
                  stopRequested.current = true;
                  setStopping(true);
                }}
              >
                {stopping ? "Stopping after current entries..." : "Stop"}
              </Button>
            ) : null}
            {stopping && running ? (
              <small style={mutedStyle}>Translations already started finish first. With a slow model, that can take a few minutes.</small>
            ) : null}
            {!running && !retrying && (failed > 0 || written > 0) ? (
              <Button variant="secondary" onClick={() => setRetrying(true)}>
                Retry...
              </Button>
            ) : null}
          </div>
        ) : null}
        {retrying && !running ? (
          <LayerCard style={cardStyle}>
            <RetryForm
              failed={failed}
              written={written}
              initialSettings={settings}
              working={false}
              onRetry={retry}
              onCancel={() => setRetrying(false)}
            />
          </LayerCard>
        ) : null}
        {total === 0 ? null : (
          <TranslationProgress percent={Math.round((results.length / total) * 100)} label={`${results.length}/${total} translations`} />
        )}
        {results.length === 0 ? null : (
          <BatchResultsTable
            collection={plan.collection}
            urlContext={urlContexts[plan.collection]}
            rows={results.map((result) => ({
              key: `${result.item.id}:${result.target.locale}`,
              title: result.item.title,
              locale: result.target.locale,
              outcome: result.outcome,
              message: result.message,
              translation: result.translation,
            }))}
          />
        )}
      </section>
    </main>
  );
}
