import { spawn } from "node:child_process";

const children = new Map();

export async function runCommand(command, args, options) {
  const invocation = resolveInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    stdout: "",
    stderr: "",
    spawnError: undefined,
    closed: new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
  };
  child.once("error", (error) => (state.spawnError = error));
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk;
    if (options.echo) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
    if (options.echo) process.stderr.write(chunk);
  });
  children.set(child, state);
  void state.closed.then(() => children.delete(child));

  const timeoutMs = options.timeoutMs ?? 120_000;
  const result = await within(state.closed, timeoutMs);
  if (result === undefined) {
    await terminateCommand(child);
    throw new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${state.stdout}${state.stderr}`);
  }
  if (state.spawnError !== undefined) throw state.spawnError;
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.code ?? result.signal}\n${state.stdout}${state.stderr}`);
  }
  return { stdout: state.stdout, stderr: state.stderr };
}

function resolveInvocation(command, args) {
  if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) return { command, args };
  const commandLine = [command, ...args].map((value) => `"${value.replaceAll('"', '""')}"`).join(" ");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
}

export async function cleanupCommands() {
  await Promise.allSettled([...children.keys()].map((child) => terminateCommand(child)));
}

async function terminateCommand(child) {
  const state = children.get(child);
  if (state === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    await within(state.closed, 1_000);
    return;
  }
  await killTree(child, false);
  if ((await within(state.closed, 5_000)) !== undefined) return;
  await killTree(child, true);
  if ((await within(state.closed, 5_000)) !== undefined) return;
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  throw new Error(`Unable to terminate process tree ${child.pid}`);
}

async function killTree(child, force) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], { stdio: "ignore" });
    const closed = new Promise((resolve) => {
      taskkill.once("error", resolve);
      taskkill.once("close", resolve);
    });
    if ((await within(closed, 3_000)) === undefined) taskkill.kill();
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function within(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs, undefined);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
