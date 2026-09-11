import { PluginRouteError, type LogAccess } from "emdash";

export function throwTranslationFailure(error: unknown, log: LogAccess, operation: string, exposeReason = true): never {
  const message = translationFailureMessage(error, log, operation, exposeReason);
  throw new PluginRouteError("TRANSLATION_FAILED", message, 502);
}

export function translationFailureMessage(
  error: unknown,
  log: LogAccess,
  operation: string,
  exposeReason = true,
  diagnosticId: string = crypto.randomUUID(),
): string {
  if (error instanceof PluginRouteError || (error instanceof Error && error.name === "AbortError")) throw error;
  const message = exposeReason ? publicTranslationFailure(error) : "PolyStella translation failed";
  log.error("PolyStella translation failed", {
    diagnosticId,
    operation,
    errorType: error instanceof Error ? error.name : typeof error,
    message,
  });
  return `${message} (Diagnostic ID: ${diagnosticId})`;
}

export function publicTranslationFailure(error: unknown): string {
  if (!(error instanceof Error)) return "PolyStella translation failed";
  const firstLine = error.message.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "PolyStella translation failed";
  if (!safeTranslationFailure(firstLine)) return "PolyStella translation failed";
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}...` : firstLine;
}

function safeTranslationFailure(message: string): boolean {
  return (
    message.startsWith("[polystella] no segment markers in the model response.") ||
    message.startsWith("[polystella] model omitted segment ") ||
    message.startsWith("[polystella] model returned an empty translation for segment ") ||
    /^\[polystella\] Workers AI request failed: \d{3}(?: [A-Za-z ]+)?$/.test(message) ||
    message.startsWith("[polystella] unexpected Workers AI response shape ") ||
    message.startsWith("[polystella] unexpected Workers AI binding response shape ") ||
    message.startsWith("[polystella] token-preservation validation failed for ") ||
    message.startsWith("[polystella-emdash] missing translation for internal segment ") ||
    message.startsWith("[polystella-emdash] missing translation for sandbox text") ||
    message.startsWith("[polystella-emdash] translation changed placeholder tokens in field ")
  );
}
