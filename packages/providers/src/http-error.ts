import { PermanentProviderError } from "@cloudflare/polystella-core";

const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 422]);

export async function createProviderHttpError(providerName: string, response: Response, signal?: AbortSignal | undefined): Promise<Error> {
  const text = await response.text().catch(() => "");
  signal?.throwIfAborted();
  const message = `[polystella] ${providerName} request failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ""}`;
  return PERMANENT_HTTP_STATUSES.has(response.status) ? new PermanentProviderError(message) : new Error(message);
}
