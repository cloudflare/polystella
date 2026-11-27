import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import { CaretDownIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { AiTranslationStatus } from "../../contracts.js";
import { errorMessage, pluginRequest, shortModelName } from "../utils.js";
import { mutedStyle, rowStyle, stackStyle } from "../styles.js";
import { ErrorMessage } from "../components/ErrorMessage/ErrorMessage.js";

/** Save hooks can clear the flag after the save responds, so a save triggers a second, delayed check. */
const POST_SAVE_RECHECK_MS = 2_000;
const CONFIRMATION_MS = 4_000;

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
          <div style={{ ...rowStyle, justifyContent: "space-between" }}>
            <FlagBadge
              variant={edited === null || edited.length > 0 ? "warning" : "info"}
              label={edited === null ? "Couldn't check for edits" : edited.length > 0 ? "Edited after AI translation" : "AI-translated"}
              details={[
                edited === null
                  ? "PolyStella couldn't compare the saved text with its AI translation, so it can't tell whether an editor changed it."
                  : null,
                status.aiTranslatedAt === null
                  ? null
                  : `Translated ${new Date(status.aiTranslatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`,
                status.model === null ? null : `Model: ${shortModelName(status.model)}`,
              ].filter((line) => line !== null)}
            />
            <Button
              size="sm"
              variant="ghost"
              style={linkButtonStyle}
              loading={working === "remove"}
              disabled={working !== null}
              onClick={() => onReview("remove")}
            >
              Remove flag
            </Button>
          </div>
          {!needsReview ? null : (
            <>
              <small style={mutedStyle}>
                {edited !== null && edited.length > 0 ? `Changed: ${edited.map(fieldLabel).join(", ")}. ` : ""}
                Readers keep seeing the AI-translated notice until an editor picks Keep or Remove. Keep AI flag keeps the notice and treats
                the current text as reviewed; Remove flag removes the notice.
              </small>
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={working === "keep"}
                  disabled={working !== null}
                  onClick={() => onReview("keep")}
                >
                  Keep AI flag
                </Button>
              </div>
            </>
          )}
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

/** The flag's badge; its chevron opens the translation date and model on hover, focus, or click. */
function FlagBadge({ variant, label, details }: { variant: "info" | "warning"; label: string; details: readonly string[] }): ReactNode {
  const [open, setOpen] = useState(false);
  if (details.length === 0) return <Badge variant={variant}>{label}</Badge>;
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      delay={150}
      content={
        <span style={{ display: "grid", gap: 2 }}>
          {details.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
      render={
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          style={{ background: "none", border: "none", cursor: "help", font: "inherit", padding: 0 }}
        />
      }
    >
      <Badge variant={variant}>
        <span style={{ alignItems: "center", display: "inline-flex", gap: 2 }}>
          {label}
          <CaretDownIcon aria-hidden="true" size={12} />
        </span>
      </Badge>
    </Tooltip>
  );
}

const linkButtonStyle: CSSProperties = { textDecoration: "underline dotted", textUnderlineOffset: 3 };
