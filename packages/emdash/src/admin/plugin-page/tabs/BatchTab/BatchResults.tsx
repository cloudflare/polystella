import { fetchManifest, getPreviewUrl, Link } from "@emdash-cms/admin";
import { Button, Table } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import type { BatchTranslationLink } from "../../../../contracts.js";
import { mutedStyle, rowStyle, stackStyle } from "../../../styles.js";
import { publicContentUrl, type PublicUrlContext } from "./helpers.js";

export interface BatchResultRow {
  key: string;
  title: string;
  locale: string;
  outcome: string;
  message: string | null;
  translation: BatchTranslationLink | null;
}

/** Public-URL settings per collection from EmDash's admin manifest; empty until it loads or if it fails. */
export function usePublicUrlContexts(): Record<string, PublicUrlContext> {
  const [contexts, setContexts] = useState<Record<string, PublicUrlContext>>({});
  useEffect(() => {
    let active = true;
    fetchManifest()
      .then((manifest) => {
        if (!active) return;
        setContexts(
          Object.fromEntries(
            Object.entries(manifest.collections).map(([slug, info]) => [slug, { urlPattern: info.urlPattern, i18n: manifest.i18n }]),
          ),
        );
      })
      // Without the manifest, rows still get Edit and Preview links; only View live needs it.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return contexts;
}

export function BatchResultsTable({
  collection,
  rows,
  urlContext,
}: {
  collection: string;
  rows: readonly BatchResultRow[];
  urlContext: PublicUrlContext | undefined;
}): ReactNode {
  return (
    <div style={{ overflowX: "auto" }}>
      <Table layout="fixed" style={{ minWidth: 720 }}>
        <Table.Header>
          <Table.Row>
            <Table.Head style={{ width: "35%" }}>Entry</Table.Head>
            <Table.Head style={{ width: "15%" }}>Locale</Table.Head>
            <Table.Head style={{ width: "15%" }}>Result</Table.Head>
            <Table.Head>Details</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((row) => (
            <Table.Row key={row.key}>
              <Table.Cell>{row.title}</Table.Cell>
              <Table.Cell>{row.locale}</Table.Cell>
              <Table.Cell>{row.outcome}</Table.Cell>
              <Table.Cell>
                <div style={stackStyle}>
                  {row.message === null ? null : <span style={mutedStyle}>{row.message}</span>}
                  {row.translation === null ? null : (
                    <TranslationLinks collection={collection} translation={row.translation} urlContext={urlContext} />
                  )}
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </div>
  );
}

// Links open in a new tab so following one never stops a run in this tab.
function TranslationLinks({
  collection,
  translation,
  urlContext,
}: {
  collection: string;
  translation: BatchTranslationLink;
  urlContext: PublicUrlContext | undefined;
}): ReactNode {
  const liveUrl = translation.published && urlContext !== undefined ? publicContentUrl(translation, urlContext) : null;
  return (
    <div style={rowStyle}>
      <Link
        to="/content/$collection/$id"
        params={{ collection, id: translation.id }}
        search={{ locale: translation.locale }}
        target="_blank"
        rel="noopener noreferrer"
      >
        Edit
      </Link>
      {liveUrl === null ? null : (
        <a href={liveUrl} target="_blank" rel="noopener noreferrer">
          View live
        </a>
      )}
      {translation.published ? null : (
        <Button size="sm" variant="ghost" onClick={() => void openPreview(collection, translation, urlContext)}>
          Preview draft
        </Button>
      )}
    </div>
  );
}

/** Same as EmDash's editor: a signed preview URL, or the public path when previews aren't configured. */
async function openPreview(collection: string, translation: BatchTranslationLink, urlContext: PublicUrlContext | undefined): Promise<void> {
  const preview = await getPreviewUrl(collection, translation.id);
  const url = preview?.url ?? (urlContext === undefined ? null : publicContentUrl(translation, urlContext));
  if (url !== null) window.open(url, "_blank", "noopener,noreferrer");
}
