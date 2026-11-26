// @ts-check
// A signed-in connection to a local copy of this playground. Scripts that write through dev-bypass go through it,
// because dev-bypass signs in and writes to whatever server answers.

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const PLAYGROUND_MARKER = '<meta name="polystella-playground" content="emdash"';

/** A refusal to talk to a server that is not this playground. The message is meant for the person running the script. */
export class GuardError extends Error {}

/**
 * @typedef {{ status: number; ok: boolean; data: any; error: any }} ApiResult
 * @param {string} origin For example http://localhost:4322
 */
export async function connect(origin) {
  const base = origin.replace(/\/$/, "");
  if (!LOCAL_HOSTS.includes(new URL(base).hostname)) {
    throw new GuardError(`${base} is not a local address. This only writes to a dev server on this machine.`);
  }
  // No redirects: a redirect could pass the check on another page while the writes still go to `base`.
  const home = await fetch(`${base}/`, { redirect: "manual" }).then(
    (response) => (response.status === 200 ? response.text() : ""),
    () => "",
  );
  if (!home.includes(PLAYGROUND_MARKER)) {
    throw new GuardError(`${base} does not look like a local copy of the PolyStella EmDash playground. Nothing was written.`);
  }

  const login = await fetch(`${base}/_emdash/api/setup/dev-bypass?redirect=/`, { redirect: "manual" });
  const cookie = login.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  if (cookie === "") throw new Error("dev-bypass returned no session cookie; it only works under `astro dev`");

  /** @param {string} method @param {string} path Relative to /_emdash/api. @param {unknown} [body] @returns {Promise<ApiResult>} */
  async function request(method, path, body) {
    const response = await fetch(`${base}/_emdash/api${path}`, {
      method,
      headers: { Cookie: cookie, "X-EmDash-Request": "1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => undefined);
    return { status: response.status, ok: payload?.success === true, data: payload?.data, error: payload?.error };
  }

  /** Like `request`, but throws when the call fails and returns only the data. */
  /** @param {string} method @param {string} path @param {unknown} [body] */
  async function api(method, path, body) {
    const result = await request(method, path, body);
    if (!result.ok)
      throw new Error(`${method} ${path} failed with ${result.status}: ${JSON.stringify(result.error ?? "not a JSON response")}`);
    return result.data;
  }

  return {
    origin: base,
    request,
    api,
    /** @param {string} method @param {string} path Relative to the plugin's routes. @param {unknown} [body] */
    plugin: (method, path, body) => api(method, `/plugins/polystella/${path}`, body),
    /** @param {string} method @param {string} path @param {unknown} [body] */
    pluginRequest: (method, path, body) => request(method, `/plugins/polystella/${path}`, body),
  };
}
