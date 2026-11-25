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
    raw: rawErrorChain(error),
  });
  return `${message} (Diagnostic ID: ${diagnosticId})`;
}

const MAX_LOGGED_CAUSES = 5;
const MAX_LOGGED_MESSAGE_CHARACTERS = 4000;

/** Server log only: the full message (provider response previews included), code, and cause chain. */
function rawErrorChain(error: unknown): Array<{ name: string; message: string; code?: unknown; providerResponse?: unknown }> {
  const chain: Array<{ name: string; message: string; code?: unknown; providerResponse?: unknown }> = [];
  let current = error;
  while (current !== undefined && chain.length < MAX_LOGGED_CAUSES) {
    const message = current instanceof Error ? current.message : String(current);
    const code = current instanceof Error && "code" in current ? current.code : undefined;
    const providerResponse = current instanceof Error && "providerResponse" in current ? current.providerResponse : undefined;
    chain.push({
      name: current instanceof Error ? current.name : typeof current,
      message: message.length > MAX_LOGGED_MESSAGE_CHARACTERS ? `${message.slice(0, MAX_LOGGED_MESSAGE_CHARACTERS)}...` : message,
      ...(code === undefined ? {} : { code }),
      ...(providerResponse === undefined ? {} : { providerResponse }),
    });
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

export function publicTranslationFailure(error: unknown): string {
  if (!(error instanceof Error)) return "PolyStella translation failed";
  const firstLine = error.message.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "PolyStella translation failed";
  // Workers AI only reports its own timeout as a "3046: " message prefix, with no separate code.
  if (error.name === "AiError" && firstLine.startsWith("3046:")) return modelTimeoutMessage("Workers AI error 3046");
  if (error.name === "ProviderTimeoutError")
    return modelTimeoutMessage(firstLine.replace("[polystella] the model did not answer ", "no reply "));
  if (!safeTranslationFailure(firstLine)) return "PolyStella translation failed";
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}...` : firstLine;
}

function modelTimeoutMessage(detail: string): string {
  return `The translation model timed out (${detail}). Try again, or translate fewer fields at once or pick a faster model.`;
}

function safeTranslationFailure(message: string): boolean {
  return (
    message.startsWith("[polystella] no segment markers in the model response.") ||
    message.startsWith("[polystella] model omitted segment ") ||
    message.startsWith("[polystella] model returned an empty translation for segment ") ||
    /^\[polystella\] Workers AI request failed: \d{3}(?: [A-Za-z ]+)?$/.test(message) ||
    message.startsWith("[polystella] unexpected Workers AI response shape ") ||
    message.startsWith("[polystella] unexpected Workers AI binding response shape ") ||
    message.startsWith("[polystella] model ran out of output tokens ") ||
    message.startsWith("[polystella] model changed inline markup in ") ||
    message.startsWith("[polystella] prompt for segment ") ||
    message.startsWith("[polystella] message validation failed for ") ||
    message.startsWith("[polystella-emdash] missing translation for internal segment ") ||
    message.startsWith("[polystella-emdash] missing translation for sandbox text") ||
    message.startsWith("[polystella-emdash] translation changed placeholder tokens in field ")
  );
}
