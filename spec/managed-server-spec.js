const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, prepareProject, removeProject } = require("./helpers/project");
const { exerciseServer } = require("./helpers/exercise-server");
const { liveSuite } = require("./helpers/environment");
liveSuite("ide-swift verified managed toolchain", () => {
  let directory, client, edge, managed, manager, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 900000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "ide-swift-managed-"),
    );
    for (const name of ["ide", "ide-swift"]) await lumine.packages.activatePackage(name);
    const main = lumine.packages.getActivePackage("ide-swift").mainModule;
    edge = main.consumeIde({
      registerAdapter(adapter) {
        client = new LiveLspClient(adapter, path.join(directory, "project"));
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
  });
  afterEach(async () => {
    await client?.stop();
    edge?.dispose();
    managed?.dispose();
    await manager?.deactivate();
    for (const key of ["serverPath", "toolchainPath"]) lumine.config.unset(`ide-swift.${key}`);
    for (const name of ["ide-swift", "ide"]) await lumine.packages.deactivatePackage(name);
    await removeProject(directory);
  });
  it("verifies the complete official SDK, stages all resources and launches its real server", async () => {
    const clientPath = lumine.packages.getActivePackage("ide").path;
    const Managed = require(path.join(clientPath, "lib", "managed-servers"));
    const LanguageServerManager = require(path.join(clientPath, "lib", "language-server-manager"));
    const storagePath = path.join(directory, "managed");
    manager = new LanguageServerManager();
    manager.registerAdapter(client.adapter);
    managed = new Managed(manager, { storageRoot: storagePath });
    const actual = managed.apiFor(client.adapter);
    const api = {
      downloadFile: async (url, target, options) => {
        const cached = process.env.SWIFT_INSTALLER_CACHE;
        if (
          cached &&
          process.platform === "win32" &&
          url.startsWith("https://download.swift.org/") &&
          url.endsWith(".exe")
        ) {
          expect(options.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          await fs.promises.copyFile(cached, target);
          const hash = crypto.createHash("sha256");
          for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
          expect(`sha256:${hash.digest("hex")}`).toBe(options.digest);
          return target;
        }
        return actual.downloadFile(url, target, options);
      },
      githubReleaseByTag: (...args) => actual.githubReleaseByTag(...args),
      setServerInstallationStatus: (status) => actual.setServerInstallationStatus(status),
    };
    const installer = require("../lib/installer");
    const installed = await installer.installServer({
      storagePath,
      version: process.env.SWIFT_VERSION || "6.4.0",
      api,
    });
    expect(installed.version).toBe(process.env.SWIFT_VERSION || "6.4.0");
    expect(installed.binaryChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(storagePath, "provenance", "Swift-LICENSE.txt"))).toBe(true);
    if (process.platform === "win32") {
      expect(installed.checksum).toMatch(/^sha256:/);
      expect(fs.existsSync(path.join(storagePath, "provenance", "swift-authenticode.json"))).toBe(
        true,
      );
      expect(
        fs.existsSync(
          path.join(storagePath, "sdk", "SourceDir", "LocalApp", "Programs", "Swift", "Platforms"),
        ),
      ).toBe(true);
    } else if (process.platform === "linux")
      expect(installed.signingFingerprint).toBe(installer.signingFingerprint);
    const binaryPath = path.join(storagePath, installed.binary);
    const fixture = createProject(path.join(directory, "project"));
    await prepareProject(fixture, binaryPath);
    lumine.config.set("ide-swift.serverPath", "");
    lumine.config.set("ide-swift.toolchainPath", "");
    await client.start({ binaryPath, version: installed.version });
    const covered = await exerciseServer(client, fixture);
    expect(covered).toContain("module definition");
    expect(covered).toContain("type subtypes");
    expect(covered).toContain("inlay hint resolve");
  });
});
