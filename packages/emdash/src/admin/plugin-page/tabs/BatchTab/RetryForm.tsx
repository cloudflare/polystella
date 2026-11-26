import { Button, Switch } from "@cloudflare/kumo";
import { useState, type ReactNode } from "react";

import type { BatchJobSettings } from "../../../../contracts.js";
import { EMPTY_JOB_SETTINGS, JobSettingsFields, jobSettingsPayload } from "../../../components/JobSettings/JobSettings.js";
import { InfoLabel } from "../../../components/PageHeader/PageHeader.js";
import { rowStyle, stackStyle } from "../../../styles.js";
import { plural } from "../../../utils.js";

/** Retries failed rows, and optionally the translations the run wrote, with settings prefilled from the run. */
export function RetryForm({
  failed,
  notRun = 0,
  moreToList = false,
  written,
  initialSettings,
  working,
  onRetry,
  onCancel,
}: {
  failed: number;
  /** Translations a cancel stopped before they ran. */
  notRun?: number | undefined;
  /** A cancel stopped listing the collection; the retry lists the rest. */
  moreToList?: boolean | undefined;
  /** Translations the run created or updated. */
  written: number;
  initialSettings: BatchJobSettings | null;
  working: boolean;
  onRetry(settings: BatchJobSettings | null, redo: boolean): void;
  onCancel(): void;
}): ReactNode {
  const [settings, setSettings] = useState(initialSettings ?? EMPTY_JOB_SETTINGS);
  const [redo, setRedo] = useState(failed + notRun === 0);
  const count = failed + notRun + (redo ? written : 0);
  return (
    <div style={stackStyle}>
      <JobSettingsFields value={settings} disabled={working} onChange={setSettings} />
      {written === 0 ? null : (
        <Switch
          aria-label={`Also redo the ${plural(written, "translation")} it wrote`}
          label={
            <InfoLabel
              label={`Also redo the ${plural(written, "translation")} it wrote`}
              info="Translates them again in place. Translations that were published, scheduled, or edited since are skipped."
            />
          }
          checked={redo}
          disabled={working}
          onCheckedChange={setRedo}
        />
      )}
      <div style={rowStyle}>
        <Button
          variant="primary"
          size="sm"
          loading={working}
          disabled={count === 0 && !moreToList}
          onClick={() => onRetry(jobSettingsPayload(settings), redo)}
        >
          Retry {plural(count, "translation")}
          {moreToList ? " and the rest of the collection" : ""}
        </Button>
        <Button variant="secondary" size="sm" disabled={working} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
