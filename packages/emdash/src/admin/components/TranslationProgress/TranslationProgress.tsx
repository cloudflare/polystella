import type { ReactNode } from "react";

import type { TranslationProgressState } from "../../types.js";
import { mutedStyle } from "../../styles.js";

export function TranslationProgress({ percent, label }: TranslationProgressState): ReactNode {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <progress aria-label={label} value={percent} max={100} style={{ width: "100%" }} />
      <small style={mutedStyle}>
        {percent}%: {label}
      </small>
    </div>
  );
}
