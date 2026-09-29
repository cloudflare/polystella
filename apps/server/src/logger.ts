/**
 * Braintrust wrapper �� lazy-loaded to avoid CJS errors in Workers runtime.
 *
 * The Braintrust SDK has CJS dependencies that cause "exports is not defined"
 * errors when statically imported at module scope in Workers. We use dynamic
 * import() to defer loading until first use.
 *
 * Pattern borrowed from cto-agent (src/lib/braintrust.ts).
 *
 * Configuration:
 * - Reads credentials from Workers env bindings (passed via `initBraintrust`)
 * - Requires BRAINTRUST_API_KEY, BRAINTRUST_API_URL, BRAINTRUST_PROJECT_NAME
 * - Optionally uses CF Access headers when BRAINTRUST_CF_ACCESS_CLIENT_ID/SECRET are set
 * - Falls back to noops when credentials are missing or SDK fails to load
 */
import type { Span } from 'braintrust';

// ── Environment config ────────────────────────────────────────────────────────

interface BraintrustConfig {
  apiKey: string;
  apiUrl: string;
  projectName: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

let config: BraintrustConfig | null = null;

/**
 * Initialize Braintrust with environment bindings.
 * Call once per request (idempotent — only the first call takes effect).
 *
 * Typically called in middleware or at the top of your request handler:
 *   initBraintrust(c.env)
 */
export function initBraintrust(env: {
  BRAINTRUST_API_KEY?: string;
  BRAINTRUST_API_URL?: string;
  BRAINTRUST_PROJECT_NAME?: string;
  BRAINTRUST_CF_ACCESS_CLIENT_ID?: string;
  BRAINTRUST_CF_ACCESS_CLIENT_SECRET?: string;
}): void {
  // Only configure once
  if (config) return;

  if (
    !env.BRAINTRUST_API_KEY ||
    !env.BRAINTRUST_API_URL ||
    !env.BRAINTRUST_PROJECT_NAME
  ) {
    console.warn(
      '[braintrust] Disabled — missing required env vars:',
      [
        !env.BRAINTRUST_API_KEY && 'BRAINTRUST_API_KEY',
        !env.BRAINTRUST_API_URL && 'BRAINTRUST_API_URL',
        !env.BRAINTRUST_PROJECT_NAME && 'BRAINTRUST_PROJECT_NAME'
      ]
        .filter(Boolean)
        .join(', ')
    );
    return;
  }

  config = {
    apiKey: env.BRAINTRUST_API_KEY,
    apiUrl: env.BRAINTRUST_API_URL,
    projectName: env.BRAINTRUST_PROJECT_NAME,
    cfAccessClientId: env.BRAINTRUST_CF_ACCESS_CLIENT_ID,
    cfAccessClientSecret: env.BRAINTRUST_CF_ACCESS_CLIENT_SECRET
  };
}

// ── Lazy SDK loader ───────────────────────────────────────────────────────────

let sdk: typeof import('braintrust') | null = null;
let loadPromise: Promise<typeof import('braintrust') | null> | null = null;
const FLUSH_TIMEOUT_MS = 60_000;

async function loadSDK(): Promise<typeof import('braintrust') | null> {
  if (sdk) return sdk;
  const currentConfig = config;
  if (!currentConfig) return null;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const bt = await import('braintrust');

      const accessHeaders =
        currentConfig.cfAccessClientId && currentConfig.cfAccessClientSecret
          ? {
              'CF-Access-Client-Id': currentConfig.cfAccessClientId,
              'CF-Access-Client-Secret': currentConfig.cfAccessClientSecret
            }
          : null;

      bt.initLogger({
        projectName: currentConfig.projectName,
        apiKey: currentConfig.apiKey,
        appUrl: currentConfig.apiUrl,
        noExitFlush: true,
        // Inject CF Access headers when talking to internal Braintrust instance
        ...(accessHeaders && {
          fetch: (url: string | URL | Request, options?: RequestInit) => {
            return fetch(url, {
              ...options,
              headers: {
                ...options?.headers,
                ...accessHeaders
              }
            });
          }
        })
      });

      sdk = bt;
      console.log('[braintrust] SDK initialized successfully');
      return bt;
    } catch (err) {
      console.error('[braintrust] Failed to load SDK:', err);
      return null;
    }
  })();

  return loadPromise;
}

// ── Noop span for when SDK isn't available ────────────────────────────────────

const NOOP_SPAN = {
  log: () => {},
  end: () => 0,
  close: () => 0,
  traced: <R>(cb: () => R) => cb(),
  startSpan: () => NOOP_SPAN
} as unknown as Span;

// ── Exported wrappers ─────────────────────────────────────────────────────────

/**
 * traced() — wraps a callback with a Braintrust tracing span.
 * Lazy-loads the SDK on first call; falls back to noop if SDK fails to load
 * or credentials are not configured.
 */
type SpanType = 'function' | 'llm' | 'score' | 'eval' | 'task' | 'tool';

export function traced<R>(
  callback: (span: Span) => R | Promise<R>,
  args?: { name?: string; type?: SpanType }
): Promise<R> {
  // Fast path: no config means noop
  if (!config) {
    return Promise.resolve(callback(NOOP_SPAN));
  }

  // Fast path: SDK already loaded
  if (sdk) {
    return sdk.traced(callback, args) as Promise<R>;
  }

  // First call: load SDK then execute
  return (async () => {
    const bt = await loadSDK();
    if (!bt) return callback(NOOP_SPAN);
    return bt.traced(callback, args);
  })() as Promise<R>;
}

/**
 * Flush all pending Braintrust logs. Call via executionCtx.waitUntil().
 * Noops if Braintrust is not configured.
 */
export async function flushBraintrust(): Promise<void> {
  if (!config) return;

  try {
    const bt = await loadSDK();
    if (!bt) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      bt.flush(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                `Braintrust flush timed out after ${FLUSH_TIMEOUT_MS}ms`
              )
            ),
          FLUSH_TIMEOUT_MS
        );
      })
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
    console.log('[braintrust] Flush complete');
  } catch (err) {
    console.error('[braintrust] Flush failed:', err);
  }
}
