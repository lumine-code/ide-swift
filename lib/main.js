const server = require("./server");
const installer = require("./installer");
const setting = (name) => lumine.config.get(`ide-swift.${name}`);
const options = () =>
  Object.fromEntries(
    ["backgroundIndexing"].flatMap((name) =>
      setting(name) === "enabled"
        ? [[name, true]]
        : setting(name) === "disabled"
          ? [[name, false]]
          : [],
    ),
  );
module.exports = {
  consumeIdeClient(client) {
    return client.registerAdapter({
      id: "ide-swift",
      displayName: "SourceKit-LSP",
      grammarScopes: ["source.swift"],
      languageId: "swift",
      sessionScope: "project-root",
      restartKeyPaths: [
        "ide-swift.serverPath",
        "ide-swift.toolchainPath",
        "ide-swift.backgroundIndexing",
      ],
      managedServerDisplayName: "Swift toolchain",
      installServer: installer.installServer,
      latestServerVersion: installer.latestServerVersion,
      // Swift's lenses invoke editor-owned run/debug/test commands. Registering
      // their names as server commands would claim an integration we do not own.
      isFeatureAvailable: (feature) => feature !== "codeLens",
      getInitializationOptions: options,
      async resolveServer(context) {
        const launch = await server.resolveServer(context, {
          serverPath: setting("serverPath"),
          toolchainPath: setting("toolchainPath"),
        });
        if (!launch) {
          client.reportMissingServer("ide-swift", {
            description:
              "Install a complete Swift toolchain through Manage Servers or swift.org, or select its SourceKit-LSP executable. Windows also requires the platform C++ tools and Windows SDK. The server, compiler and SDK must remain together.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
      },
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-swift",
      tips: [
        "Swift packages get completion, navigation and refactorings from SourceKit-LSP. Open the folder containing Package.swift and keep the matching Swift toolchain available.",
      ],
    };
  },
};
