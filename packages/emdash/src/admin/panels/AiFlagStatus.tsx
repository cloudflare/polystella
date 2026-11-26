import { Badge, Button } from "@cloudflare/kumo";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AiTranslationStatus } from "../../contracts.js";
import { errorMessage, pluginRequest, shortModelName } from "../utils.js";
import { mutedStyle, rowStyle, stackStyle } from "../styles.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";
import { TextTooltip } from "../components/PageHeader/PageHeader.js";

/** Save hooks can clear the flag after the save responds, so a save triggers a second, delayed check. */
const POST_SAVE_RECHECK_MS = 2_000;
const CONFIRMATION_MS = 4_000;
const MAX_MODEL_CHARS = 28;

type ReviewAction = "keep" | "remove";

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
  const [working, setWorking] = useState<ReviewAction | null>(null);
  const [failure, setFailure] = useState<{ message: string; retry: ReviewAction | "load" } | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ collection, entryId });
    pluginRequest<AiTranslationStatus>(`ai-translation/status?${query.toString()}`)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setFailure((current) => (current?.retry === "load" ? null : current));
      })
      .catch((cause: unknown) => {
        if (active) setFailure({ message: errorMessage(cause), retry: "load" });
      });
    return () => {
      active = false;
    };
  }, [collection, entryId, savedAt, reload]);

  const firstSavedAt = useRef(savedAt);
  useEffect(() => {
    if (savedAt === firstSavedAt.current) return;
    const timer = setTimeout(() => setReload((current) => current + 1), POST_SAVE_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);

  useEffect(() => {
    const recheck = (): void => {
      if (document.visibilityState === "visible") setReload((current) => current + 1);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);

  useEffect(() => {
    if (confirmation === null) return;
    const timer = setTimeout(() => setConfirmation(null), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [confirmation]);

  async function review(action: ReviewAction): Promise<void> {
    setWorking(action);
    setFailure(null);
    setConfirmation(null);
    try {
      await pluginRequest("ai-translation/review", { method: "POST", body: JSON.stringify({ collection, entryId, action }) });
      setConfirmation(action === "keep" ? "AI flag kept." : "AI flag removed.");
      setReload((current) => current + 1);
    } catch (cause) {
      setFailure({ message: errorMessage(cause), retry: action });
    } finally {
      setWorking(null);
    }
  }

  return (
    <AiFlagStatusView
      status={status}
      working={working}
      error={failure?.message ?? null}
      confirmation={confirmation}
      fieldLabel={fieldLabel}
      onReview={(action) => void review(action)}
      onRetry={() => {
        if (failure === null || failure.retry === "load") setReload((current) => current + 1);
        else void review(failure.retry);
      }}
    />
  );
}

/** What `AiFlagStatus` shows for a loaded status; `editedFields: null` means PolyStella couldn't tell whether anyone edited the text. */
export function AiFlagStatusView({
  status,
  working,
  error,
  confirmation,
  fieldLabel,
  onReview,
  onRetry,
}: {
  status: AiTranslationStatus | null;
  working: ReviewAction | null;
  error: string | null;
  confirmation: string | null;
  fieldLabel(slug: string): string;
  onReview(action: ReviewAction): void;
  onRetry(): void;
}): ReactNode {
  const flagged = status !== null && status.aiTranslated;
  const edited = flagged ? status.editedFields : [];
  const needsReview = edited === null || edited.length > 0;
  // Hidden rather than unmounted when empty: the panel's grid would add a gap, and Remove's confirmation outlives the flag.
  return (
    <div style={!flagged && error === null && confirmation === null ? { display: "none" } : stackStyle}>
      {!flagged ? null : (
        <>
          <div style={rowStyle}>
            {edited === null ? (
              <Badge variant="warning">
                <TextTooltip content="PolyStella couldn't compare the saved text with its AI translation, so it can't tell whether an editor changed it.">
                  Couldn't check for edits
                </TextTooltip>
              </Badge>
            ) : (
              <Badge variant={edited.length > 0 ? "warning" : "info"}>
                {edited.length > 0 ? "Edited after AI translation" : "AI-translated"}
              </Badge>
            )}
            <small style={mutedStyle}>
              {status.aiTranslatedAt === null
                ? ""
                : `Translated ${new Date(status.aiTranslatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`}
              {status.model === null ? null : (
                <>
                  {" with "}
                  <TextTooltip content={status.model} label={`Model: ${status.model}`}>
                    {truncatedModelName(status.model)}
                  </TextTooltip>
                </>
              )}
            </small>
          </div>
          {!needsReview ? null : (
            <small style={mutedStyle}>
              {edited !== null && edited.length > 0 ? `Changed: ${edited.map(fieldLabel).join(", ")}. ` : ""}
              Readers keep seeing the AI-translated notice until an editor picks Keep or Remove. Keep AI flag keeps the notice and treats
              the current text as reviewed; Remove AI flag removes the notice.
            </small>
          )}
          <div style={rowStyle}>
            {!needsReview ? null : (
              <Button
                size="sm"
                variant="secondary"
                loading={working === "keep"}
                disabled={working !== null}
                onClick={() => onReview("keep")}
              >
                Keep AI flag
              </Button>
            )}
            <Button size="sm" variant="ghost" loading={working === "remove"} disabled={working !== null} onClick={() => onReview("remove")}>
              Remove AI flag
            </Button>
          </div>
        </>
      )}
      {error === null ? null : (
        <>
          <ErrorMessage>{error}</ErrorMessage>
          <div>
            <Button size="sm" variant="secondary" disabled={working !== null} onClick={onRetry}>
              Retry
            </Button>
          </div>
        </>
      )}
      <small role="status" style={mutedStyle}>
        {confirmation}
      </small>
    </div>
  );
}

function truncatedModelName(model: string): string {
  const name = shortModelName(model);
  return name.length > MAX_MODEL_CHARS ? `${name.slice(0, MAX_MODEL_CHARS - 1)}…` : name;
}
