import { Button, Switch } from "@cloudflare/kumo";
import { useState, type ReactNode } from "react";

import type { BatchJobSettings } from "../../../../contracts.js";
import {
  EMPTY_JOB_SETTINGS,
  JobSettingsFields,
  jobSettingsError,
  jobSettingsPayload,
} from "../../../components/JobSettings/JobSettings.js";
import { InfoLabel } from "../../../components/PageHeader/PageHeader.js";
import { mutedStyle, rowStyle, stackStyle } from "../../../styles.js";
import { plural } from "../../../utils.js";

/** Retries failed rows, and optionally the translations the run wrote, with settings prefilled from the run. */
export function RetryForm({
  failed,
  notRun = 0,
  moreToList = false,
  written,
  initialSettings,
  working,
  blocked = false,
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
  /** Another job action is running, so Retry waits for it. */
  blocked?: boolean | undefined;
  onRetry(settings: BatchJobSettings | null, redo: boolean): void;
  onCancel(): void;
}): ReactNode {
  const [settings, setSettings] = useState(initialSettings ?? EMPTY_JOB_SETTINGS);
  const [redo, setRedo] = useState(failed + notRun === 0);
  const count = failed + notRun + (redo ? written : 0);
  return (
    <div style={stackStyle}>
      <span style={mutedStyle}>Change these for this retry only. Anything left empty uses the translation settings.</span>
      <JobSettingsFields value={settings} disabled={working} onChange={setSettings} />
      {written === 0 ? null : (
        <Switch
          aria-label={`Also redo the ${plural(written, "translation")} this run created or updated`}
          label={
            <InfoLabel
              label={`Also redo the ${plural(written, "translation")} this run created or updated`}
              info="Translates them again and overwrites them. Any that were published, scheduled or edited since this run are left alone."
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
          disabled={blocked || (count === 0 && !moreToList) || jobSettingsError(settings) !== undefined}
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
