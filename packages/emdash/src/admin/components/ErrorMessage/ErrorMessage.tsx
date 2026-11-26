import { Banner } from "@cloudflare/kumo";
import type { ReactNode } from "react";

/** Kumo's Banner isn't a live region, so the wrapper announces the error. */
export function ErrorMessage({ children }: { children: ReactNode }): ReactNode {
  return (
    <div role="alert">
      <Banner variant="error" title="PolyStella couldn't complete that request" description={children} />
    </div>
  );
}
