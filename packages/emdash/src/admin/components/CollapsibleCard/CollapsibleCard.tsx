import { Button, LayerCard } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import { useId, type CSSProperties, type ReactNode } from "react";

import { cardStyle, stackStyle } from "../../styles.js";

/** A card whose body opens and closes with the control at its top right. Without `children` it has no control. */
export function CollapsibleCard({
  header,
  label,
  open,
  onOpenChange,
  children,
}: {
  header: ReactNode;
  /** Names the card in the control's accessible label, such as "Pages". */
  label: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  children?: ReactNode;
}): ReactNode {
  const bodyId = useId();
  const expandable = children !== undefined && children !== null && children !== false;
  return (
    <LayerCard style={cardStyle}>
      <div style={stackStyle}>
        <div style={headerStyle}>
          <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 12, minWidth: 0 }}>{header}</div>
          {expandable ? (
            <Button
              variant="ghost"
              shape="square"
              size="sm"
              icon={open ? CaretUpIcon : CaretDownIcon}
              aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
              aria-expanded={open}
              aria-controls={open ? bodyId : undefined}
              onClick={() => onOpenChange(!open)}
            />
          ) : null}
        </div>
        {expandable && open ? (
          <div id={bodyId} style={stackStyle}>
            {children}
          </div>
        ) : null}
      </div>
    </LayerCard>
  );
}

const headerStyle: CSSProperties = { alignItems: "center", display: "flex", gap: 12, justifyContent: "space-between" };

/** Columns of at least 420px: two on PolyStella pages, one on narrow screens. */
export const cardGridStyle: CSSProperties = {
  alignItems: "start",
  display: "grid",
  gap: 20,
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))",
};
