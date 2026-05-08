# GitHub Copilot in VS Code → Opper

The CLI now ships an adapter that does the Stable-channel setup for you:

```bash
opper editors github-copilot-vscode
```

It detects the OAI Compatible community extension, prompts before
installing it (with a marketplace link and a clean cancel path), then
writes the Opper provider block into your VS Code user `settings.json`.
Remove with `opper editors github-copilot-vscode --remove`.

The artifacts in this directory are the manual recipe — useful as a
reference, for users who don't have the CLI installed, or for the
Insiders channel where the native BYOK path isn't currently usable.

## What this gets you

- **In scope:** Copilot **Chat** and **Agent mode** in VS Code, answered by
  Opper-routed models from the curated picker (`src/config/models.ts`).
- **Out of scope:** Inline ghost-text completions still go to GitHub's own
  Copilot service. BYOK does not redirect them. Embeddings, repository
  indexing, intent detection and a few other side queries also keep
  hitting GitHub's service.
- **Auth:** API key entered once via VS Code's "Manage Models" UI; stored
  in the OS keychain (Insiders) or by the community extension (Stable),
  not in `settings.json`.
- **Subscription gates:** Copilot Free / Pro have BYOK on by default.
  Copilot Business / Enterprise users need their org admin to enable the
  "Bring Your Own Language Model Key in VS Code" policy.

## Files

- `generate.ts` — derives both JSON snippets from `PICKER_MODELS`. Run
  `npx tsx docs/copilot-vscode/generate.ts` after any model-list change.
- `insiders-settings.json` — paste-ready block for **VS Code Insiders**
  using the native `github.copilot.chat.customOAIModels` setting.
- `stable-settings.json` — paste-ready block for **VS Code Stable**, used
  with the community extension `johnny-zhao.oai-compatible-copilot`.

## VS Code Insiders setup (UI path)

> **Status (May 2026):** The native settings-driven path
> (`github.copilot.chat.customOAIModels`) is **deprecated** in the Copilot
> Chat extension shipped with Insiders 1.120 — it lives under
> `ConfigKey.Deprecated.CustomOAIModels` in `vscode-copilot-chat` source
> with a "remove after 6 months" TODO. It runs a one-shot migration into
> a new BYOK storage system, then ignores subsequent edits.
>
> So Insiders has no working declarative configuration today. Use the
> UI flow below; we'll revisit declarative setup once Microsoft ships
> the array-based replacement for `customOAIModels`.

The `insiders-settings.json` snippet in this directory is preserved as a
reference but should **not** be merged into Insiders user settings —
it'll be ignored.

1. Open Copilot Chat → click the model picker → **Manage Models**.
2. Click **+ Add Models…** → **OpenAI Compatible**.
3. When prompted:
   - Base URL: `https://api.opper.ai/v3/compat`
   - API key: your `OPPER_API_KEY`
   - Model id: `claude-opus-4-7` (start here; add more once one works)
4. Repeat step 2 for any additional model id from `PICKER_MODELS` you
   want surfaced.
5. Pick the model in the chat picker → send a message → confirm the
   trace lands on `https://platform.opper.ai/traces`.

## VS Code Stable setup (community extension)

Until the native custom-OAI provider lands in Stable, the community
extension is the most painless path.

1. Install the extension:
   `code --install-extension johnny-zhao.oai-compatible-copilot`
   (or search for "OAI Compatible Provider for Copilot" in the
   Extensions sidebar).
2. Open user `settings.json` and merge the contents of
   `stable-settings.json` into it (top-level keys: `oaicopilot.baseUrl`
   and `oaicopilot.models`).
3. Reload the window.
4. Open Copilot Chat → model picker → **Manage Models** → choose **OAI
   Compatible** → enter your `OPPER_API_KEY` when prompted → select the
   Opper models to surface in the picker.
5. Send a chat message using one of the new models and verify the trace
   appears on Opper.

## Testing checklist

For each model worth validating (start with `claude-opus-4-7` and one
non-Anthropic model — `gpt-5.5` or `gemini-3.1-pro-preview`):

- [ ] Plain chat reply renders end-to-end.
- [ ] Streaming chunks arrive incrementally (not just at the end).
- [ ] **Agent mode** runs a multi-step task that uses tools (e.g.
      `read_file`, `apply_patch`).
- [ ] Long-context request (paste a 20k-token prompt) doesn't truncate.
- [ ] Vision: drag in an image — for models flagged `vision: true` it
      should be accepted; for `vision: false` it should be rejected
      cleanly rather than silently ignored.
- [ ] Thinking / reasoning content surfaces (or is suppressed cleanly)
      for models flagged `thinking: true`.
- [ ] Trace lands on `https://platform.opper.ai/traces` with the right
      model id.

## What to flag back

If anything in the table below is wrong, ping me and I'll regenerate:

- A capability flag (`toolCalling`, `vision`, `thinking`) that doesn't
  match what Opper actually reports for a model.
- A `maxInputTokens` / `maxOutputTokens` that VS Code rejects or that the
  upstream model can't honour.
- A model id that `/v3/compat` returns "unknown model" for.
- Any model that needs a different `apiMode` than `"openai"` (Stable
  extension only — Insiders pins to OpenAI shape).

## Promotion to phase 2

Once the JSON is stable, the adapter lives in
`src/agents/github-copilot-vscode.ts` as a configure-only adapter (mirror
of `claude-desktop.ts`):

- `configure()` writes a sentinel-bracketed `customOAIModels` entry into
  the user `settings.json` for whichever channel is detected.
- `unconfigure()` strips it.
- No `spawn()` — VS Code is launched by the user, not by us.

The `generate.ts` logic here becomes the body of `configure()`; the
`VISION` set either graduates onto `PickerModel` in `src/config/models.ts`
or sits beside the new adapter.
