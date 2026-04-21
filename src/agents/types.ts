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

export interface AgentAdapter {
  name: string;
  displayName: string;
  binary: string;
  docsUrl: string;

  detect(): Promise<DetectResult>;
  install(): Promise<void>;

  snapshotConfig(): Promise<SnapshotHandle>;
  writeOpperConfig(c: OpperRouting): Promise<void>;
  restoreConfig(h: SnapshotHandle): Promise<void>;

  spawn(args: string[]): Promise<number>;
}
