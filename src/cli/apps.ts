import type { Command } from "commander";
import type { CliContext, RegisterFn } from "./types.js";
import { appsShellCommand } from "../commands/apps-shell.js";
import {
  appsListCommand,
  appsGetCommand,
  appsCreateCommand,
  appsRedeployCommand,
  appsDeleteCommand,
  appsLogsCommand,
  appsRunCommand,
  appsSecretsListCommand,
  appsSecretsSetCommand,
  appsSecretsDeleteCommand,
} from "../commands/apps.js";

// `opper apps` — deploy agent source as a managed app (Opper Apps).
// The app spec (resources, scaling, description) lives in an opper.yaml
// next to the source, fly.io-style.
const register: RegisterFn = (program: Command, ctx: CliContext) => {
  const apps = program
    .command("apps")
    .description("Deploy and manage agents as managed apps");

  apps
    .command("list")
    .description("List apps in the project")
    .action(async () => {
      await appsListCommand({ key: ctx.key() });
    });

  apps
    .command("get")
    .description("Show app status, size, and invoke URL")
    .argument("<name>", "app name")
    .action(async (name: string) => {
      await appsGetCommand({ name, key: ctx.key() });
    });

  apps
    .command("create")
    .description("Upload source (or clone a repo) and deploy a new app")
    .option("--name <name>", "app name; defaults to `name:` from opper.yaml")
    .option("--dir <path>", "source directory", ".")
    .option("--repo <url>", "git repo to clone and deploy (instead of --dir)")
    .option("--ref <branch|tag>", "branch or tag to clone (with --repo)")
    .option("--config <json>", 'config overrides, e.g. {"cpu":1,"memory":2048}')
    .action(
      async (cmdOpts: {
        name?: string;
        dir: string;
        repo?: string;
        ref?: string;
        config?: string;
      }) => {
        await appsCreateCommand({
          ...(cmdOpts.name ? { name: cmdOpts.name } : {}),
          dir: cmdOpts.dir,
          ...(cmdOpts.repo ? { repo: cmdOpts.repo } : {}),
          ...(cmdOpts.ref ? { ref: cmdOpts.ref } : {}),
          ...(cmdOpts.config ? { config: cmdOpts.config } : {}),
          key: ctx.key(),
        });
      },
    );

  apps
    .command("redeploy")
    .description("Upload new source and roll the app")
    .argument("<name>", "app name")
    .option("--dir <path>", "source directory", ".")
    .action(async (name: string, cmdOpts: { dir: string }) => {
      await appsRedeployCommand({ name, dir: cmdOpts.dir, key: ctx.key() });
    });

  apps
    .command("delete")
    .description("Stop and remove an app")
    .argument("<name>", "app name")
    .action(async (name: string) => {
      await appsDeleteCommand({ name, key: ctx.key() });
    });

  apps
    .command("logs")
    .description("Stream app logs (Ctrl+C to stop)")
    .argument("<name>", "app name")
    .action(async (name: string) => {
      await appsLogsCommand({ name, key: ctx.key() });
    });

  apps
    .command("run")
    .description("Invoke the app once")
    .argument("<name>", "app name")
    .requiredOption("--input <text>", "input passed to the agent")
    .action(async (name: string, cmdOpts: { input: string }) => {
      await appsRunCommand({ name, input: cmdOpts.input, key: ctx.key() });
    });

  apps
    .command("shell")
    .description("Open an interactive terminal in the running app")
    .argument("<name>", "app name")
    .action(async (name: string) => {
      await appsShellCommand({ name, key: ctx.key() });
    });

  const secrets = apps
    .command("secrets")
    .description("Manage encrypted app secrets (applied on redeploy)");

  secrets
    .command("list")
    .description("List secret names")
    .argument("<app>", "app name")
    .action(async (app: string) => {
      await appsSecretsListCommand({ app, key: ctx.key() });
    });

  secrets
    .command("set")
    .description("Set or update a secret")
    .argument("<app>", "app name")
    .argument("<name>", "secret name, e.g. OPPER_API_KEY")
    .argument("<value>", "secret value")
    .action(async (app: string, name: string, value: string) => {
      await appsSecretsSetCommand({ app, name, value, key: ctx.key() });
    });

  secrets
    .command("delete")
    .description("Delete a secret")
    .argument("<app>", "app name")
    .argument("<name>", "secret name")
    .action(async (app: string, name: string) => {
      await appsSecretsDeleteCommand({ app, name, key: ctx.key() });
    });
};

export default register;
