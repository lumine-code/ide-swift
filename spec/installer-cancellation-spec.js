const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("Swift installer cancellation ownership", () => {
  let installer, directory;
  beforeEach(async () => {
    spyOn(global, "fetch").and.resolveTo({ ok: true, text: async () => "metadata" });
    spyOn(childProcess, "execFile").and.callFake((_command, _args, _options, callback) => {
      callback(new Error("Controlled process boundary"), "", "");
    });
    await lumine.packages.activatePackage("ide-swift");
    installer = require("../lib/installer");
    directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "swift-cancel-"));
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-swift");
    const temporaryRoot = fs.realpathSync.native(os.tmpdir()) + path.sep;
    if (!directory.startsWith(temporaryRoot)) throw new Error("Unexpected test directory");
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  for (const source of ["caller", "api"]) {
    it(`does no staging or metadata work after ${source} cancellation`, async () => {
      const controller = new AbortController();
      const reason = new Error("Swift installation cancelled");
      controller.abort(reason);
      spyOn(installer, "fetchText").and.rejectWith(new Error("Controlled metadata boundary"));
      const mkdir = spyOn(fs.promises, "mkdir").and.callThrough();
      await expectAsync(
        installer.installServer({
          storagePath: path.join(directory, "stage"),
          version: "6.4.0",
          ...(source === "caller" ? { signal: controller.signal } : {}),
          api: source === "api" ? { signal: controller.signal } : {},
        }),
      ).toBeRejectedWith(reason);
      expect(mkdir).not.toHaveBeenCalled();
      expect(installer.fetchText).not.toHaveBeenCalled();
    });
  }
  it("uses the caller lifetime for metadata fetch and keeps a successful response", async () => {
    const controller = new AbortController();
    expect(
      await installer.fetchText("https://www.swift.org/LICENSE.txt", { signal: controller.signal }),
    ).toBe("metadata");
    const signal = global.fetch.calls.mostRecent().args[1].signal;
    const reason = new Error("Metadata request cancelled");
    controller.abort(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    await expectAsync(
      installer.fetchText("https://www.swift.org/LICENSE.txt", { signal: controller.signal }),
    ).toBeRejectedWith(reason);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it("does not start an extraction helper with an already cancelled lifetime", async () => {
    const controller = new AbortController();
    const reason = new Error("Swift extraction cancelled");
    controller.abort(reason);
    const server = require("../lib/server");
    await expectAsync(
      server.run("controlled-helper", [], { signal: controller.signal }),
    ).toBeRejectedWith(reason);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
  it("waits for a cancelled helper to close before retiring staging", async () => {
    const controller = new AbortController();
    const reason = new Error("Swift helper cancelled");
    const child = new EventEmitter();
    childProcess.execFile.and.callFake((_command, _args, options, callback) => {
      options.signal.addEventListener("abort", () => callback(reason, "", ""), { once: true });
      return child;
    });
    let settled = false;
    const pending = require("../lib/server").run("controlled-helper", [], {
      signal: controller.signal,
    });
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort(reason);
    try {
      await new Promise(setImmediate);
      expect(settled).toBe(false);
    } finally {
      child.emit("close", null, "SIGTERM");
      await observed;
    }
    await expectAsync(pending).toBeRejectedWith(reason);
  });
});
