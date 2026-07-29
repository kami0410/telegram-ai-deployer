const path = require("node:path");
const Module = require("node:module");

const runtimeEntry = path.resolve(__filename);
const entryIndex = process.argv.findIndex((argument, index) => index > 0 && path.resolve(argument) === runtimeEntry);
if (entryIndex < 0) throw new Error("Unable to locate the bundled Wrangler runtime entrypoint");
const wranglerCli = process.argv[entryIndex + 1];
if (!wranglerCli || !path.isAbsolute(wranglerCli) || path.basename(wranglerCli) !== "cli.js") {
  throw new Error("Bundled Wrangler CLI path is invalid");
}
const cliArguments = process.argv.slice(entryIndex + 2);
process.argv = process.versions.electron
  ? [process.argv[0], ...cliArguments]
  : [process.argv[0], wranglerCli, ...cliArguments];
Module._load(wranglerCli, null, true);
