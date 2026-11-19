import { Badge, Button } from "@cloudflare/kumo";
import { useEffect, useState, type ReactNode } from "react";

import type { AiTranslationStatus } from "../../contracts.js";
import { errorMessage, pluginRequest } from "../utils.js";
import { mutedStyle, rowStyle, stackStyle } from "../styles.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";

/** The entry's AI-translated flag, and Keep / Remove once an editor changed AI-written text. Reloads after each save. */
export function AiFlagStatus({
  collection,
  entryId,
  savedAt,
  fieldLabel,
}: {
  collection: string;
  entryId: string;
  savedAt: string | undefined;
  fieldLabel(slug: string): string;
}): ReactNode {
  const [status, setStatus] = useState<AiTranslationStatus | null>(null);
  const [working, setWorking] = useState<"keep" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ collection, entryId });
    pluginRequest<AiTranslationStatus>(`ai-translation/status?${query.toString()}`)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [collection, entryId, savedAt, reload]);

  async function review(action: "keep" | "remove"): Promise<void> {
    setWorking(action);
    setError(null);
    try {
      await pluginRequest("ai-translation/review", { method: "POST", body: JSON.stringify({ collection, entryId, action }) });
      setReload((current) => current + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setWorking(null);
    }
  }

  if (error !== null) return <ErrorMessage>{error}</ErrorMessage>;
  if (status === null || !status.aiTranslated) return null;
  const edited = status.editedFields ?? [];
  return (
    <div style={stackStyle}>
      <div style={rowStyle}>
        <Badge variant={edited.length > 0 ? "warning" : "info"}>
          {edited.length > 0 ? "Edited since AI translation" : "AI-translated"}
        </Badge>
        <small style={mutedStyle}>
          {status.aiTranslatedAt === null ? "" : `Translated ${new Date(status.aiTranslatedAt).toLocaleString()}`}
          {status.model === null ? "" : ` with ${status.model}`}
        </small>
      </div>
      {edited.length === 0 ? null : (
        <small style={mutedStyle}>
          Changed: {edited.map(fieldLabel).join(", ")}. Readers still see the AI-translated notice until you decide.
        </small>
      )}
      <div style={rowStyle}>
        {edited.length === 0 ? null : (
          <Button
            size="sm"
            variant="secondary"
            loading={working === "keep"}
            disabled={working !== null}
            onClick={() => void review("keep")}
          >
            Keep AI flag
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={working === "remove"} disabled={working !== null} onClick={() => void review("remove")}>
          Remove AI flag
        </Button>
      </div>
    </div>
  );
}
