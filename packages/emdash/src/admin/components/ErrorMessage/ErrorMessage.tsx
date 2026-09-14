import { Banner } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export function ErrorMessage({ children }: { children: ReactNode }): ReactNode {
  return <Banner variant="error" title="PolyStella couldn't complete that request" description={children} />;
}
