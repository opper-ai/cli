export interface Editor {
  id: "opencode" | "continue" | "cursor" | "windsurf" | "cline";
  displayName: string;
  /** True when the CLI can write config for this editor; false for docs-only. */
  configure: boolean;
  docsUrl: string;
}

const DOCS_URL = "https://docs.opper.ai/building/ai-editors";

export function listEditors(): Editor[] {
  return [
    { id: "opencode", displayName: "OpenCode", configure: true, docsUrl: DOCS_URL },
    { id: "continue", displayName: "Continue.dev", configure: true, docsUrl: DOCS_URL },
    { id: "cursor", displayName: "Cursor", configure: false, docsUrl: DOCS_URL },
    { id: "windsurf", displayName: "Windsurf", configure: false, docsUrl: DOCS_URL },
    { id: "cline", displayName: "Cline", configure: false, docsUrl: DOCS_URL },
  ];
}
