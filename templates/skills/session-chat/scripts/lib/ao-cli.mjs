import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory || ".", name);
    if (executable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function configuredCommand(command) {
  if (isAbsolute(command) || command.includes(sep)) {
    const path = resolve(command);
    return executable(path) ? path : undefined;
  }
  return executableOnPath(command);
}

function environmentInvocation(args) {
  const configured = process.env.AO_CLI;
  if (!configured || configured.trim() === "") {
    return undefined;
  }
  if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
    const script = resolve(configured);
    if (!existsSync(script) || !statSync(script).isFile()) {
      throw new Error(`AO_CLI points to a missing script: ${script}`);
    }
    return [process.execPath, [script, ...args]];
  }
  const command = configuredCommand(configured);
  if (!command) {
    throw new Error(`AO_CLI is not executable or on PATH: ${configured}`);
  }
  return [command, args];
}

function findConfig(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, ".ao", "config.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function configInvocation(args, diagnostics) {
  const configPath = findConfig();
  if (!configPath) {
    diagnostics.push(".ao/config.json was not found from the current directory");
    return undefined;
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    diagnostics.push(`${configPath} could not be read as JSON: ${error.message}`);
    return undefined;
  }
  if (
    typeof config.cli?.command !== "string" ||
    !Array.isArray(config.cli?.args) ||
    config.cli.args.length === 0 ||
    !config.cli.args.every((value) => typeof value === "string")
  ) {
    diagnostics.push(`${configPath} has no valid cli.command and cli.args`);
    return undefined;
  }
  const command = configuredCommand(config.cli.command);
  if (!command) {
    diagnostics.push(
      `${configPath} cli.command is not executable: ${config.cli.command}`,
    );
    return undefined;
  }
  const entrypoint = config.cli.args[0];
  if (isAbsolute(entrypoint) && !existsSync(entrypoint)) {
    diagnostics.push(`${configPath} CLI entrypoint is missing: ${entrypoint}`);
    return undefined;
  }
  return [command, [...config.cli.args, ...args]];
}

export function cliInvocation(args, label) {
  try {
    const environment = environmentInvocation(args);
    if (environment) {
      return environment;
    }
  } catch (error) {
    console.error(`${label}: cannot resolve ao CLI: ${error.message}`);
    process.exit(1);
  }

  const diagnostics = ["AO_CLI is not set"];
  const configured = configInvocation(args, diagnostics);
  if (configured) {
    return configured;
  }
  const pathCommand = executableOnPath("ao");
  if (pathCommand) {
    return [pathCommand, args];
  }
  diagnostics.push("PATH contains no executable ao");
  console.error(
    `${label}: cannot resolve ao CLI: ${diagnostics.join("; ")}`,
  );
  process.exit(1);
}
