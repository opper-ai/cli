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

export interface SnapshotHandle {
  agent: string;
  backupPath: string;
  timestamp: string;
}

export interface ConfigureOptions {
  /** API key for adapters that bake the key into their config (e.g. Continue.dev). */
  apiKey?: string;
}

interface BaseAgentAdapter {
  name: string;
  displayName: string;
  docsUrl: string;

  detect(): Promise<DetectResult>;
  /**
   * Returns true iff this agent is set up to use Opper. For agents that
   * auto-configure at launch (Hermes), this collapses to "installed". For
   * agents with persistent config (OpenCode, Continue.dev), this means the
   * Opper provider/models are present in the on-disk config.
   */
  isConfigured(): Promise<boolean>;
  /** Idempotent setup of the Opper integration. */
  configure(opts: ConfigureOptions): Promise<void>;
}

/** Agents you launch from the terminal (`opper launch <name>`). */
export interface LaunchableAgentAdapter extends BaseAgentAdapter {
  launchable: true;
  binary: string;
  install(): Promise<void>;
  snapshotConfig(): Promise<SnapshotHandle>;
  writeOpperConfig(c: OpperRouting): Promise<void>;
  restoreConfig(h: SnapshotHandle): Promise<void>;
  spawn(args: string[]): Promise<number>;
}

/** Editor / IDE integrations — configured once, used through the editor. */
export interface ConfigOnlyAgentAdapter extends BaseAgentAdapter {
  launchable: false;
}

export type AgentAdapter = LaunchableAgentAdapter | ConfigOnlyAgentAdapter;
