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
    .option("--wait", "wait for the build to finish; exit non-zero if it fails")
    .action(
      async (cmdOpts: {
        name?: string;
        dir: string;
        repo?: string;
        ref?: string;
        config?: string;
        wait?: boolean;
      }) => {
        await appsCreateCommand({
          ...(cmdOpts.name ? { name: cmdOpts.name } : {}),
          dir: cmdOpts.dir,
          ...(cmdOpts.repo ? { repo: cmdOpts.repo } : {}),
          ...(cmdOpts.ref ? { ref: cmdOpts.ref } : {}),
          ...(cmdOpts.config ? { config: cmdOpts.config } : {}),
          ...(cmdOpts.wait ? { wait: true } : {}),
          key: ctx.key(),
        });
      },
    );

  apps
    .command("redeploy")
    .description("Upload new source and roll the app")
    .argument("<name>", "app name")
    .option("--dir <path>", "source directory", ".")
    .option("--wait", "wait for the build to finish; exit non-zero if it fails")
    .action(async (name: string, cmdOpts: { dir: string; wait?: boolean }) => {
      await appsRedeployCommand({
        name,
        dir: cmdOpts.dir,
        ...(cmdOpts.wait ? { wait: true } : {}),
        key: ctx.key(),
      });
    });

  apps
    .command("delete")
    .description("Stop and remove an app")
    .argument("<name>", "app name")
    .option("-y, --yes", "skip the confirmation prompt")
    .action(async (name: string, cmdOpts: { yes?: boolean }) => {
      await appsDeleteCommand({
        name,
        ...(cmdOpts.yes ? { yes: true } : {}),
        key: ctx.key(),
      });
    });

  apps
    .command("logs")
    .description("Stream app logs (Ctrl+C to stop)")
    .argument("<name>", "app name")
    .action(async (name: string) => {
      await appsLogsCommand({ name, key: ctx.key() });
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
    .argument(
      "[value]",
      "secret value; omit and use --from-stdin/--from-file to keep it off argv",
    )
    .option("--from-stdin", "read the value from stdin")
    .option("--from-file <path>", "read the value from a file")
    .action(
      async (
        app: string,
        name: string,
        value: string | undefined,
        cmdOpts: { fromStdin?: boolean; fromFile?: string },
      ) => {
        await appsSecretsSetCommand({
          app,
          name,
          ...(value !== undefined ? { value } : {}),
          ...(cmdOpts.fromStdin ? { fromStdin: true } : {}),
          ...(cmdOpts.fromFile ? { fromFile: cmdOpts.fromFile } : {}),
          key: ctx.key(),
        });
      },
    );

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
