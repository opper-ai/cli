import { loadSrt } from "./srt.js";

export const backends = {
  srt: {
    platforms: ["darwin", "linux"],
    load: loadSrt,
    description: "Native filesystem guard + network proxy",
    hint: "Bundled SRT library; enable npm optional dependencies. Linux needs bubblewrap and socat.",
  },
};
export type SandboxBackend = keyof typeof backends;
