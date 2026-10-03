const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LiveLspClient } = require("./helpers/live-lsp-client");
const { createProject, prepareProject, removeProject } = require("./helpers/project");
const { exerciseServer } = require("./helpers/exercise-server");
const { serverPath, toolchainPath, liveSuite } = require("./helpers/environment");
liveSuite("ide-swift real SourceKit-LSP protocol", () => {
  let directory, client, edge, timeout;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 240000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-swift-live-"));
    lumine.config.set("ide-swift.serverPath", serverPath);
    lumine.config.set("ide-swift.toolchainPath", toolchainPath);
    const main = (await lumine.packages.activatePackage("ide-swift")).mainModule;
    edge = main.consumeIdeClient({
      registerAdapter(adapter) {
        client = new LiveLspClient(adapter, directory);
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
  });
  afterEach(async () => {
    await client.stop();
    edge.dispose();
    for (const key of ["serverPath", "toolchainPath"]) lumine.config.unset(`ide-swift.${key}`);
    await lumine.packages.deactivatePackage("ide-swift");
    await removeProject(directory);
  });
  it("serves compiler diagnostics, intelligence, module navigation, edits, hints, semantics and indexed hierarchies", async () => {
    const fixture = createProject(directory);
    await prepareProject(fixture, serverPath, toolchainPath);
    await client.start();
    const covered = await exerciseServer(client, fixture);
    expect(covered).toEqual(
      jasmine.arrayContaining([
        "diagnostics",
        "dynamic registrations",
        "completion",
        "completion resolve",
        "hover",
        "signature",
        "definition",
        "module definition",
        "references",
        "UTF-16 rename",
        "document symbols",
        "workspace symbols",
        "formatting",
        "code actions",
        "code action edits",
        "inlay hints",
        "semantic tokens",
        "incoming calls",
        "outgoing calls",
        "type subtypes",
        "type supertypes",
        "diagnostic clearing",
      ]),
    );
  });
});
