export interface WorkersAiHttpEnv {
  AI?: Ai;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_AI_SESSION_AFFINITY?: string;
}

// Toggle between Workers AI binding and direct HTTP API.
// true  => use env.AI.run(...)
// false => use Cloudflare REST API with account/token env vars
export const USE_WORKERS_AI_BINDING = true;

async function runWorkersAiViaBinding(
  env: WorkersAiHttpEnv,
  modelId: string,
  input: unknown
): Promise<unknown> {
  if (!env.AI) {
    throw new Error('Missing AI binding for Workers AI call');
  }

  return env.AI.run(
    modelId as keyof AiModels,
    input as Record<string, unknown>
  );
}

async function runWorkersAiViaHttp(
  env: WorkersAiHttpEnv,
  modelId: string,
  input: unknown
): Promise<unknown> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const sessionAffinity = env.CLOUDFLARE_AI_SESSION_AFFINITY;

  if (!accountId || !apiToken) {
    throw new Error(
      'Missing CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN for Workers AI HTTP call'
    );
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json'
  };

  if (sessionAffinity) {
    headers['X-Session-Affinity'] = sessionAffinity;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Workers AI HTTP call failed (${response.status}): ${errorBody.slice(0, 1000)}`
    );
  }

  const isStreaming = Boolean((input as Record<string, unknown>)?.['stream']);
  if (isStreaming) {
    return response;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  return payload['result'] ?? payload;
}

export async function runWorkersAi(
  env: WorkersAiHttpEnv,
  modelId: string,
  input: unknown
): Promise<unknown> {
  if (USE_WORKERS_AI_BINDING) {
    return runWorkersAiViaBinding(env, modelId, input);
  }

  return runWorkersAiViaHttp(env, modelId, input);
}
