import { Banner, Button, LayerCard } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { errorMessage, localeLabel } from "../utils.js";
import { cardStyle, mutedStyle, pageStyle, rowStyle, sectionStyle, stackStyle, titleStyle } from "../styles.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";
import { TranslationProgress } from "../components/TranslationProgress/TranslationProgress.js";
import { BatchResultsTable, usePublicUrlContexts } from "./tabs/BatchTab/BatchResults.js";
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

/** A browser batch run in its own tab, opened from the Batch translation tab. */
export function BatchRunPage(): ReactNode {
  const [runId] = useState(() => new URLSearchParams(window.location.search).get("run"));
  const [plan] = useState<BatchRunPlan | null>(() => (runId === null ? null : readBatchRun(runId)));
  const [items, setItems] = useState<BatchItem[] | null>(plan?.scope === "selected" ? plan.items : null);
  const [started, setStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const stopRequested = useRef(false);
  const urlContexts = usePublicUrlContexts();

  useEffect(() => {
    if (plan === null || plan.scope !== "all") return;
    const { sourceLocale } = plan.options;
    if (sourceLocale === undefined) {
      setError("PolyStella could not tell which locale holds the source entries. Reload the Batch tab and start again.");
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

  async function run(jobs: readonly BatchJob[]): Promise<void> {
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
          const result = await runBatchJob(job, plan.options);
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
    void run(jobs);
  }

  function retryFailed(): void {
    const failed = results.filter((result) => result.outcome === "failed");
    // Retried rows leave the table and come back with their new outcome, so the run total stays the same.
    setResults((current) => current.filter((result) => result.outcome !== "failed"));
    void run(failed);
  }

  if (plan === null) {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>PolyStella - Batch run</h1>
        <p style={mutedStyle}>
          This run was already started or has expired. Start a new one from the Batch translation tab on the PolyStella page.
        </p>
      </main>
    );
  }

  const failed = results.filter((result) => result.outcome === "failed").length;
  const finished = started && !running;
  const action = `${plan.options.updateExisting ? "Create missing translations and update existing ones" : "Create missing translations, skipping existing ones"}, ${plan.options.publish ? "and publish them" : "as drafts"}.`;

  return (
    <main style={pageStyle}>
      <h1 style={titleStyle}>PolyStella - Batch run</h1>
      <section style={sectionStyle}>
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
                : `${items.length} entries × ${plan.targets.length} locales = ${items.length * plan.targets.length} translations.`}{" "}
              {action}
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
            {!running && failed > 0 ? (
              <Button variant="secondary" onClick={retryFailed}>
                Retry {failed} failed
              </Button>
            ) : null}
          </div>
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
