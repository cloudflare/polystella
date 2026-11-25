import { LayerCard, Table } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import type { CollectionPolicyResponse } from "../../../../contracts.js";
import { cardStyle, mutedStyle, stackStyle } from "../../../styles.js";
import { errorMessage, localeLabel, plural } from "../../../utils.js";
import { collectionTranslationStats, type CollectionTranslationStats } from "./helpers.js";

/** What translating the whole collection would cover, shown in place of the entry list. */
export function CollectionSummary({
  collection,
  label,
  policy,
  fields,
  locales,
  updateExisting,
}: {
  collection: string;
  label: string;
  policy: CollectionPolicyResponse;
  fields: readonly string[];
  locales: readonly string[];
  updateExisting: boolean;
}): ReactNode {
  const [stats, setStats] = useState<CollectionTranslationStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { sourceLocale, targetLocales } = policy;

  useEffect(() => {
    if (sourceLocale === null) return;
    const controller = new AbortController();
    setStats(null);
    setError(null);
    collectionTranslationStats(collection, sourceLocale, targetLocales, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStats(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [collection, sourceLocale, targetLocales]);

  const shownLocales = targetLocales.filter(({ locale }) => locales.length === 0 || locales.includes(locale));
  const toCreate = stats === null ? 0 : locales.reduce((total, locale) => total + (stats.untranslated[locale] ?? 0), 0);
  const toUpdate = stats === null ? 0 : locales.length * stats.sourceEntries - toCreate;

  return (
    <LayerCard style={cardStyle}>
      <div style={stackStyle}>
        <h3 style={{ fontSize: 18, margin: 0 }}>{label}</h3>
        {sourceLocale === null ? (
          <span style={mutedStyle}>This collection has no source locale, so its entries can't be counted.</span>
        ) : null}
        {error === null ? null : <span style={mutedStyle}>Couldn't count entries: {error}</span>}
        {stats === null && error === null && sourceLocale !== null ? <span style={mutedStyle}>Counting entries...</span> : null}
        {stats === null ? null : (
          <>
            <span>
              <strong>{plural(stats.sourceEntries, "source entry", "source entries")}</strong> in {localeLabel(sourceLocale ?? "")}:{" "}
              {stats.publishedSourceEntries} published, {stats.sourceEntries - stats.publishedSourceEntries} not published.
            </span>
            <span>
              Translated fields: <span style={mutedStyle}>{fields.length === 0 ? "none" : fields.join(", ")}</span>
            </span>
            <Table layout="fixed">
              <Table.Header>
                <Table.Row>
                  <Table.Head>Locale</Table.Head>
                  <Table.Head>Untranslated</Table.Head>
                  <Table.Head>Translated</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {shownLocales.map(({ locale, code }) => {
                  const untranslated = stats.untranslated[locale] ?? 0;
                  return (
                    <Table.Row key={locale}>
                      <Table.Cell>{localeLabel(locale, code)}</Table.Cell>
                      <Table.Cell>{untranslated}</Table.Cell>
                      <Table.Cell>{stats.sourceEntries - untranslated}</Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
            <span style={mutedStyle}>
              {locales.length === 0
                ? "Choose target locales to see how many translations a run would make."
                : `A run creates ${plural(toCreate, "translation")}${updateExisting ? ` and updates ${toUpdate}` : `; ${toUpdate} existing ${toUpdate === 1 ? "is" : "are"} skipped`}.`}
            </span>
          </>
        )}
      </div>
    </LayerCard>
  );
}
