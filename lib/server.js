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
exports.resolveExecutable = async (candidate, platform = process.platform, signal) => {
  const command = await fs.promises.realpath(candidate);
  // Apple's /usr/bin executable is an xcrun trampoline, not a Swift toolchain.
  // Resolve it before deriving SOURCEKIT_TOOLCHAIN_PATH and the compiler PATH.
  if (platform === "darwin" && command === "/usr/bin/sourcekit-lsp") {
    const selected = await exports.run("/usr/bin/xcrun", ["--find", "sourcekit-lsp"], { signal });
    const resolved = await fs.promises.realpath(selected);
    if (resolved === command)
      throw new Error("Xcode did not resolve SourceKit-LSP from its selected toolchain.");
    return resolved;
  }
  return command;
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
exports.probe = async (command, env = {}, signal) => {
  const help = await exports.run(command, ["--help"], { env: { ...process.env, ...env }, signal });
  if (!help.includes("Language Server Protocol implementation for Swift"))
    throw new Error("The selected executable is not SourceKit-LSP.");
};
exports.resolveServer = async (context, { serverPath = "", toolchainPath = "" } = {}) => {
  const native = process.platform === "win32" ? "sourcekit-lsp.exe" : "sourcekit-lsp";
  const selected = await context.resolver.select({
    configuredPath: serverPath || (toolchainPath && path.join(toolchainPath, "usr", "bin", native)),
    managed: () => {
      const installed = context.getManagedServer();
      return installed ? { path: installed.binaryPath, version: installed.version } : null;
    },
    kind: "executable",
    signal: context.signal,
    candidates: async () => {
      const candidates = context.resolver.findExecutables("sourcekit-lsp");
      if (process.platform === "darwin") {
        try {
          candidates.push(
            await exports.run("/usr/bin/xcrun", ["--find", "sourcekit-lsp"], {
              signal: context.signal,
            }),
          );
        } catch {
          /* No selected Xcode toolchain. */
        }
      }
      return candidates;
    },
    async validate(candidate, { signal }) {
      const command = await exports.resolveExecutable(candidate, process.platform, signal);
      await context.resolver.validateFile(command, { kind: "executable", signal });
      const env = exports.toolchainEnvironment(command, toolchainPath);
      await exports.probe(command, env, signal);
      return { command, env };
    },
  });
  if (!selected) return null;
  return context.resolver.launch(
    { ...selected, path: selected.data.command },
    {
      signal: context.signal,
      env: selected.data.env,
      cwd: context.rootPath,
      transport: "stdio",
    },
  );
};
