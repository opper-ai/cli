export interface DetectResult {
  installed: boolean;
  version?: string;
  configPath?: string;
}

export interface OpperRouting {
  baseUrl: string;
  apiKey: string;
  model: string;
  compatShape: "openai" | "anthropic" | "responses";
}

export interface ConfigureOptions {
  /** API key for adapters that bake the key into their config. */
  apiKey?: string;
}

export interface SpawnOptions {
  /**
   * Where the adapter should write its persistent Opper config. Adapters
   * without a project-level config concept (Codex, Pi, Claude Code, …)
   * ignore this. "user" is the default — the per-user-machine config is
   * the safe place to land, and writing there doesn't pollute repos.
   * "project" opts into writing the cwd-local config, which is useful
   * for pinning a model per repo.
   */
  configScope?: "user" | "project";
}

/**
 * One unified contract for everything we route through Opper — launchable
 * CLI agents (Hermes, OpenCode, Claude Code, Codex, Pi) and editor-only
 * integrations.
 *
 * Capabilities are signalled by the *presence* of optional methods:
 *   - `spawn` present → the agent can be launched (`opper launch <name>`).
 *   - `install` present → the adapter knows how to install the binary.
 *   - everything else (configure, unconfigure, isConfigured) is required so
 *     we can ask any adapter "are you set up?" and "set yourself up".
 *
 * Adapters that mutate the agent's persistent config at launch (Hermes)
 * own the snapshot / restore dance internally inside `spawn`; they do not
 * leak that machinery into the launch orchestrator.
 */
export interface AgentAdapter {
  name: string;
  displayName: string;
  docsUrl: string;

  detect(): Promise<DetectResult>;

  /**
   * Returns true iff this agent is set up to use Opper. For agents that
   * apply the routing at launch time (Hermes, env-var-based ones) this
   * collapses to "installed". For agents with persistent config the file
   * must contain the Opper provider/models.
   */
  isConfigured(): Promise<boolean>;

  /** Idempotent setup of the Opper integration. */
  configure(opts: ConfigureOptions): Promise<void>;

  /**
   * Idempotent removal of the Opper integration. Should leave the agent's
   * own config and binary alone — only the Opper bits go away.
   */
  unconfigure(): Promise<void>;

  /** Optional: run the upstream agent's installer. Throws when not supported. */
  install?(): Promise<void>;

  /**
   * Optional: launch the agent with the given routing applied. Adapters
   * decide *how* to apply routing (env vars, in-process config rewrite,
   * etc.) and own any snapshot / restore needed for non-permanent
   * mutations.
   *
   * Adapters without this method are configure-only (e.g. editor
   * integrations).
   */
  spawn?(
    args: string[],
    routing: OpperRouting,
    opts?: SpawnOptions,
  ): Promise<number>;
}

/** Narrowed shape — useful at call sites that have already gated on `spawn`. */
export type LaunchableAgentAdapter = AgentAdapter & {
  spawn: NonNullable<AgentAdapter["spawn"]>;
};

/** Type guard — adapter is launchable iff it provides a `spawn` method. */
export function isLaunchable(a: AgentAdapter): a is LaunchableAgentAdapter {
  return typeof a.spawn === "function";
}
