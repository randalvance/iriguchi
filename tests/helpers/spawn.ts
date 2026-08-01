import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";

export type SpawnedProcess = {
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
};

type SpawnOptions = {
  cmd: string[];
  env?: NodeJS.ProcessEnv;
  // Accepted for call-site parity with the Bun.spawn signature this replaces;
  // node:child_process always pipes both here.
  stdout?: "pipe";
  stderr?: "pipe";
};

/**
 * Spawn a child process exposing stdout as a web ReadableStream.
 *
 * Mirrors the `Bun.spawn` shape the suite used before the Node migration, so
 * the `getReader()` loops that scrape child output needed no rewriting.
 */
export function spawn(options: SpawnOptions): SpawnedProcess {
  const [command, ...args] = options.cmd;
  const child = nodeSpawn(command!, args, {
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    kill: () => child.kill(),
  };
}
