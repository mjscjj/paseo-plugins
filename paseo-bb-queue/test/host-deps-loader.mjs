import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const paseoBin = realpathSync(
  execFileSync("which", ["paseo"], { encoding: "utf8" }).trim(),
);
const hostPkgUrl = pathToFileURL(path.resolve(paseoBin, "../../package.json")).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "zod" ||
      specifier === "@getpaseo/plugin" ||
      specifier.startsWith("@getpaseo/plugin/")
    ) {
      return nextResolve(specifier, { ...context, parentURL: hostPkgUrl });
    }
    return nextResolve(specifier, context);
  },
});
