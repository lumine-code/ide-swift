const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { removeProject } = require("./helpers/project");

describe("ide-swift adapter and distribution integrity", () => {
  let main, server, installer, bundle, adapter, edge, directory, changed;
  const configure = (name, value) => {
    changed.add(name);
    lumine.config.set(`ide-swift.${name}`, value);
  };
  const register = () => {
    edge = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: jasmine.createSpy("dispose") };
      },
      reportMissingServer: jasmine.createSpy("missing"),
    });
  };
  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage("ide-swift")).mainModule;
    server = require("../lib/server");
    installer = require("../lib/installer");
    bundle = require("../lib/windows-bundle");
    changed = new Set();
    directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-swift-unit-"));
    register();
  });
  afterEach(async () => {
    edge?.dispose();
    for (const key of changed) lumine.config.unset(`ide-swift.${key}`);
    await lumine.packages.deactivatePackage("ide-swift");
    await removeProject(directory);
  });
  it("owns the service edge and registers only Swift", () => {
    expect(adapter.id).toBe("ide-swift");
    expect(adapter.grammarScopes).toEqual(["source.swift"]);
    expect(adapter.languageId).toBe("swift");
    expect(adapter.installServer).toBe(installer.installServer);
    expect(adapter.managedServer).toBeUndefined();
    expect(edge.dispose).not.toHaveBeenCalled();
  });
  it("provides a useful tip and independent edge disposables", () => {
    const first = { dispose: jasmine.createSpy("first") },
      second = { dispose: jasmine.createSpy("second") };
    expect(main.consumeIdeClient({ registerAdapter: () => first })).toBe(first);
    expect(main.consumeIdeClient({ registerAdapter: () => second })).toBe(second);
    first.dispose();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(main.provideBackgroundTips().packageName).toBe("ide-swift");
    expect(main.provideBackgroundTips().tips.length).toBe(1);
  });
  it("preserves project indexing defaults and maps only explicit overrides", () => {
    expect(adapter.getInitializationOptions()).toEqual({});
    configure("backgroundIndexing", "disabled");
    expect(adapter.getInitializationOptions()).toEqual({ backgroundIndexing: false });
    configure("backgroundIndexing", "enabled");
    expect(adapter.getInitializationOptions()).toEqual({ backgroundIndexing: true });
  });
  it("does not invent server commands for client run/debug/test lenses", () => {
    expect(adapter.isFeatureAvailable("codeLens")).toBe(false);
    expect(adapter.isFeatureAvailable("typeHierarchy")).toBe(true);
    expect(require("../package.json").configSchema.features.properties.codeLens).toBeUndefined();
  });
  it("reacquires the package generation after awaited unload and reload", async () => {
    const previous = main;
    edge.dispose();
    await lumine.packages.deactivatePackage("ide-swift");
    await lumine.packages.unloadPackage("ide-swift");
    lumine.packages.loadPackage("ide-swift");
    main = (await lumine.packages.activatePackage("ide-swift")).mainModule;
    installer = require("../lib/installer");
    register();
    expect(main).not.toBe(previous);
    expect(adapter.installServer).toBe(installer.installServer);
  });
  it("reports an absent server through the hub", async () => {
    const missing = jasmine.createSpy("missing");
    main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return edge;
      },
      reportMissingServer: missing,
    });
    spyOn(server, "resolveServer").and.resolveTo(null);
    expect(await adapter.resolveServer({ rootPath: directory })).toBeNull();
    expect(missing.calls.argsFor(0)[0]).toBe("ide-swift");
    expect(missing.calls.argsFor(0)[1].description).toContain("complete Swift toolchain");
  });
  it("prefers an explicit server and never probes a managed or PATH fallback", async () => {
    spyOn(server, "probe").and.resolveTo();
    spyOn(server, "executablesOnPath");
    expect(
      (await server.resolveServer(process.execPath, { binaryPath: "/other/server" })).command,
    ).toBe(process.execPath);
    expect(server.executablesOnPath).not.toHaveBeenCalled();
  });
  it("prefers an explicitly selected toolchain over the managed installation", async () => {
    const native = process.platform === "win32" ? "sourcekit-lsp.exe" : "sourcekit-lsp";
    const executable = path.join(directory, "usr", "bin", native);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
    spyOn(server, "probe").and.resolveTo();
    spyOn(server, "executablesOnPath");
    const launch = await server.resolveServer("", { binaryPath: "/other/server" }, directory);
    expect(launch.command).toBe(executable);
    expect(launch.env.SOURCEKIT_TOOLCHAIN_PATH).toBe(directory);
    expect(server.executablesOnPath).not.toHaveBeenCalled();
  });
  it("uses a managed matched-toolchain server before PATH", async () => {
    spyOn(server, "probe").and.resolveTo();
    spyOn(server, "executablesOnPath");
    expect(
      (await server.resolveServer("", { binaryPath: process.execPath, version: "6.4.0" })).version,
    ).toBe("6.4.0");
    expect(server.executablesOnPath).not.toHaveBeenCalled();
  });
  it("resolves Apple's launcher to the selected Xcode toolchain before probing", async () => {
    const selected =
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/sourcekit-lsp";
    spyOn(fs.promises, "realpath").and.callFake(async (file) => file);
    spyOn(server, "run").and.resolveTo(selected);
    expect(await server.resolveExecutable("/usr/bin/sourcekit-lsp", "darwin")).toBe(selected);
    expect(server.run).toHaveBeenCalledOnceWith("/usr/bin/xcrun", ["--find", "sourcekit-lsp"]);
  });
  it("keeps native Linux executables and explicit macOS toolchains independent of xcrun", async () => {
    spyOn(fs.promises, "realpath").and.callFake(async (file) => file);
    spyOn(server, "run");
    expect(await server.resolveExecutable("/usr/bin/sourcekit-lsp", "linux")).toBe(
      "/usr/bin/sourcekit-lsp",
    );
    const selected = path.join(directory, "usr", "bin", "sourcekit-lsp");
    expect(await server.resolveExecutable(selected, "darwin")).toBe(selected);
    expect(server.run).not.toHaveBeenCalled();
  });
  it("surfaces an unavailable selected Xcode toolchain instead of reusing its launcher", async () => {
    spyOn(fs.promises, "realpath").and.callFake(async (file) => file);
    spyOn(server, "run").and.rejectWith(new Error("No selected Xcode toolchain"));
    await expectAsync(
      server.resolveExecutable("/usr/bin/sourcekit-lsp", "darwin"),
    ).toBeRejectedWithError(/No selected Xcode toolchain/);
    server.run.and.resolveTo("/usr/bin/sourcekit-lsp");
    await expectAsync(
      server.resolveExecutable("/usr/bin/sourcekit-lsp", "darwin"),
    ).toBeRejectedWithError(/did not resolve SourceKit-LSP/);
  });
  it("derives the launch environment from the resolved server's matched toolchain", async () => {
    const executable = path.join(directory, "usr", "bin", "sourcekit-lsp");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
    spyOn(server, "resolveExecutable").and.resolveTo(executable);
    spyOn(server, "probe").and.resolveTo();
    const launch = await server.resolveServer("/usr/bin/sourcekit-lsp", null);
    expect(launch.command).toBe(executable);
    expect(launch.env.SOURCEKIT_TOOLCHAIN_PATH).toBe(directory);
    expect(server.probe).toHaveBeenCalledWith(executable, launch.env);
  });
  it("skips an unusable PATH candidate but refuses to replace an explicit invalid selection", async () => {
    spyOn(server, "executablesOnPath").and.returnValue([
      path.join(directory, "absent"),
      process.execPath,
    ]);
    spyOn(server, "probe").and.resolveTo();
    expect((await server.resolveServer("", null)).command).toBe(process.execPath);
    await expectAsync(
      server.resolveServer(path.join(directory, "absent"), { binaryPath: process.execPath }),
    ).toBeRejected();
  });
  it("probes actual server help instead of accepting any executable", async () => {
    spyOn(server, "run").and.resolveTo("Node.js v24");
    await expectAsync(server.probe(process.execPath)).toBeRejectedWithError(/not SourceKit-LSP/);
  });
  it("preserves the caller SDKROOT and does not mutate the process environment", () => {
    const previous = process.env.SOURCEKIT_TOOLCHAIN_PATH;
    const env = server.toolchainEnvironment(process.execPath, directory, {
      PATH: "existing",
      SDKROOT: "project-sdk",
    });
    expect(env.SOURCEKIT_TOOLCHAIN_PATH).toBe(directory);
    expect(env.SDKROOT).toBeUndefined();
    expect(process.env.SOURCEKIT_TOOLCHAIN_PATH).toBe(previous);
  });
  it("selects exact supported Linux distribution and architecture archives", () => {
    expect(
      installer.linuxDistribution("6.4.0", 'ID=ubuntu\nVERSION_ID="24.04"\n', "x64"),
    ).toContain("ubuntu2404/swift-6.4.0-RELEASE/swift-6.4.0-RELEASE-ubuntu24.04.tar.gz");
    expect(installer.linuxDistribution("6.4.0", "ID=ubuntu\nVERSION_ID=24.04", "arm64")).toContain(
      "ubuntu2404-aarch64",
    );
    expect(() => installer.linuxDistribution("6.4.0", "ID=unknown\nVERSION_ID=1")).toThrowError(
      /do not match/,
    );
    expect(() =>
      installer.linuxDistribution("6.4.0", "ID=ubuntu\nVERSION_ID=24.04", "ia32"),
    ).toThrowError(/no Linux toolchain/);
  });
  it("requires the official WinGet installer URL and its published SHA256", () => {
    const checksum = "7".repeat(64);
    const yaml = `- Architecture: x64\n  InstallerUrl: https://download.swift.org/swift-6.4.0-release/windows10/swift-6.4.0-RELEASE/swift-6.4.0-RELEASE-windows10.exe\n  InstallerSha256: ${checksum}\n`;
    expect(installer.windowsDistribution(yaml, "6.4.0", "x64").digest).toBe(`sha256:${checksum}`);
    expect(() =>
      installer.windowsDistribution(
        yaml.replace("download.swift.org", "example.org"),
        "6.4.0",
        "x64",
      ),
    ).toThrowError(/exact official/);
    expect(() =>
      installer.windowsDistribution(yaml.replace(checksum, ""), "6.4.0", "x64"),
    ).toThrowError(/SHA256/);
    expect(() => installer.windowsDistribution(yaml, "6.4.0", "ia32")).toThrowError(/no Windows/);
  });
  it("reads stable toolchain releases and rejects unsupported metadata", async () => {
    spyOn(installer, "fetchText").and.resolveTo(
      JSON.stringify([{ name: "6.3.3" }, { name: "6.4.0" }, { name: "main-snapshot" }]),
    );
    expect(await installer.latestServerVersion()).toBe("6.4.0");
    installer.fetchText.and.resolveTo("[]");
    await expectAsync(installer.latestServerVersion()).toBeRejectedWithError(/no supported stable/);
    await expectAsync(
      installer.installServer({ storagePath: directory, version: "../escape", api: {} }),
    ).toBeRejectedWithError(/stable Swift 6.x/);
  });
  it("pins the independently published Swift release key fingerprint", () => {
    expect(installer.signingFingerprint).toBe("52bb7e3de28a71be22ec05ffef80a866b47a981f");
  });
  it("verifies real binary signatures in the editor stream realm and rejects tampering and foreign keys", async () => {
    const openpgp = require("openpgp");
    const generated = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519",
      userIDs: [{ name: "Swift installer regression fixture" }],
    });
    const bytes = new Uint8Array([0, 255, 13, 10, 128, 0, 65]);
    const signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: bytes }),
      signingKeys: await openpgp.readPrivateKey({ armoredKey: generated.privateKey }),
      detached: true,
    });
    const archive = path.join(directory, "signed-data.bin");
    fs.writeFileSync(archive, bytes);
    const key = await openpgp.readKey({ armoredKey: generated.publicKey });
    await installer.verifyPgpData(archive, signature, key);
    await expectAsync(
      installer.verifyPgp(archive, signature, generated.publicKey),
    ).toBeRejectedWithError(/pinned official fingerprint/);
    fs.appendFileSync(archive, new Uint8Array([1]));
    await expectAsync(installer.verifyPgpData(archive, signature, key)).toBeRejected();
  }, 30000);
  it("refuses foreign metadata URLs and unsafe extraction paths", async () => {
    await expectAsync(installer.fetchText("https://example.org/sdk")).toBeRejectedWithError(
      /Unexpected Swift/,
    );
    expect(() => bundle.resolveInside(directory, "../escape")).toThrowError(/escapes/);
    expect(() => bundle.resolveInside(directory, path.resolve(directory, "file"))).toThrowError(
      /Unsafe/,
    );
    expect(() => removeProject(os.tmpdir())).toThrowError(/unsafe/);
  });
  it("rejects malformed PE/container metadata before extracting any payload", () => {
    expect(() => bundle.containers(Buffer.alloc(64), 100)).toThrowError(/not a PE/);
    const header = Buffer.alloc(128);
    header.writeUInt16LE(0x5a4d, 0);
    header.writeUInt32LE(500, 60);
    expect(() => bundle.containers(header, 100)).toThrowError(/Invalid Swift PE/);
  });
  it("reads embedded payload metadata as data without interpreting installer actions", () => {
    const xml =
      '<BurnManifest><Payload FilePath="cli.noasserts.msi" SourcePath="a3" Packaging="embedded" Container="WixAttachedContainer" Hash="abc"/><Payload FilePath="remote.exe" Packaging="external"/></BurnManifest>';
    expect(bundle.payloads(xml).length).toBe(1);
    expect(bundle.payloads(xml)[0].FilePath).toBe("cli.noasserts.msi");
  });
});
