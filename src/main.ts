import { pathToFileURL } from "node:url";

export const HELP = `Context Overflow POC

Usage:
  context-overflow --help

Commands under construction:
  prepare   Build and validate a compact context package
  inspect   Inspect a committed run and receipt
  retrieve  Retrieve omitted bytes by durable handle
  verify    Re-run integrity and reconstruction validation
`;

export interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
}

export function runCli(
  args: readonly string[],
  io: CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value)
  }
): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }

  io.stderr(`Unknown command: ${args[0] ?? ""}\n\n${HELP}`);
  return 2;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  process.exitCode = runCli(process.argv.slice(2));
}

