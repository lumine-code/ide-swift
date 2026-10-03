const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

exports.run = (command, args, options = {}) =>
  new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 20000, ...options },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(String(stderr || stdout || error.message).trim(), { cause: error }))
          : resolve(String(stdout || stderr).trim()),
    ),
  );
exports.executablesOnPath = (name, env = process.env) => {
  const found = [];
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of process.platform === "win32" ? ["", ".exe"] : [""]) {
      const file = path.join(directory, name + suffix);
      try {
        if (fs.statSync(file).isFile()) {
          fs.accessSync(file, fs.constants.X_OK);
          found.push(file);
        }
      } catch {
        /* Keep searching. */
      }
    }
  }
  return [...new Set(found)];
};
exports.toolchainEnvironment = (command, configured = "", env = process.env) => {
  const bin = path.dirname(command);
  const toolchain =
    configured ||
    (path.basename(bin) === "bin" && path.basename(path.dirname(bin)) === "usr"
      ? path.dirname(path.dirname(bin))
      : "");
  const extra = [bin];
  const result = {};
  if (toolchain) result.SOURCEKIT_TOOLCHAIN_PATH = toolchain;
  // Portable Windows extraction retains the MSI's SourceDir and full Swift
  // layout. The runtime MSI places DLLs at SourceDir; installed SDKs normally
  // expose those DLLs through the system's existing environment.
  if (process.platform === "win32") {
    let directory = toolchain || bin;
    while (directory !== path.dirname(directory)) {
      if (fs.existsSync(path.join(directory, "swiftCore.dll"))) extra.push(directory);
      if (path.basename(directory) === "Swift") {
        const platforms = path.join(directory, "Platforms");
        if (!env.SDKROOT && fs.existsSync(platforms)) {
          const candidates = fs
            .readdirSync(platforms)
            .map((version) =>
              path.join(platforms, version, "Windows.platform", "Developer", "SDKs", "Windows.sdk"),
            )
            .filter((sdk) => fs.existsSync(path.join(sdk, "SDKSettings.json")));
          if (candidates.length === 1) result.SDKROOT = candidates[0];
        }
      }
      directory = path.dirname(directory);
    }
  }
  result.PATH = [...new Set(extra)].join(path.delimiter) + path.delimiter + (env.PATH || "");
  return result;
};
exports.probe = async (command, env = {}) => {
  const help = await exports.run(command, ["--help"], { env: { ...process.env, ...env } });
  if (!help.includes("Language Server Protocol implementation for Swift"))
    throw new Error("The selected executable is not SourceKit-LSP.");
};
exports.resolveServer = async (configured, managed, toolchain = "") => {
  const native = process.platform === "win32" ? "sourcekit-lsp.exe" : "sourcekit-lsp";
  let candidates = configured
    ? [configured]
    : toolchain
      ? [path.join(toolchain, "usr", "bin", native)]
      : managed?.binaryPath
        ? [managed.binaryPath]
        : exports.executablesOnPath("sourcekit-lsp");
  if (!candidates.length && process.platform === "darwin") {
    try {
      candidates = [await exports.run("/usr/bin/xcrun", ["--find", "sourcekit-lsp"])];
    } catch {
      /* No selected Xcode toolchain. */
    }
  }
  for (const candidate of candidates) {
    try {
      const command = await fs.promises.realpath(candidate);
      if (!(await fs.promises.stat(command)).isFile())
        throw new Error("SourceKit-LSP path is not an executable file.");
      await fs.promises.access(command, fs.constants.X_OK);
      const env = exports.toolchainEnvironment(command, toolchain);
      await exports.probe(command, env);
      return {
        command,
        args: [],
        env,
        version: configured || toolchain ? undefined : managed?.version,
      };
    } catch (error) {
      if (configured || toolchain || managed?.binaryPath) throw error;
    }
  }
  return null;
};
