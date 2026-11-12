export interface DuneOptions {
  domains: string[];
  env: string[];
  write: string[];
  /**
   * Block every host that is not allowed, instead of the default: permit
   * everything the machine policy does not deny. Implied by --allow-domain.
   */
  strict?: boolean;
  /** Decrypt HTTPS in the proxy to log each request's method and URL path. */
  logUrls?: boolean;
}
export function parseDuneArgs(argv: string[]): {
  command: string[];
  options: DuneOptions;
  mode: "run" | "help" | "observe";
} {
  const options: DuneOptions = { domains: [], env: [], write: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-")) break;
    if (arg === "--help" || arg === "-h")
      return { command: [], options, mode: "help" };
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--log-urls") {
      options.logUrls = true;
      continue;
    }
    const [flag, ...inline] = arg.split("=");
    const target =
      flag === "--allow-domain"
        ? options.domains
        : flag === "--env"
          ? options.env
          : flag === "--allow-write"
            ? options.write
            : undefined;
    if (!target)
      throw new Error(
        `Unknown Dune option: ${flag}. Put command options after the executable.`,
      );
    const value = inline.length ? inline.join("=") : argv[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value.`);
    if (flag === "--env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
      throw new Error(
        "--env takes an environment variable name, not its value.",
      );
    target.push(value);
  }
  const command = argv.slice(i);
  return {
    command,
    options,
    mode:
      argv[0] === "observe" && argv.length === 1
        ? "observe"
        : command.length
          ? "run"
          : "help",
  };
}
