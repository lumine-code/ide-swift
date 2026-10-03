const { resolveInlayHint } = require("./helpers/exercise-server");

describe("Swift live inlay hint resolution negotiation", () => {
  let client, hint;
  beforeEach(() => {
    hint = { position: { line: 1, character: 2 }, label: ": Int" };
    client = {
      capabilities: {},
      registrations: [],
      request: jasmine.createSpy("request").and.resolveTo(hint),
    };
  });
  it("resolves hints when the server advertises static resolve support", async () => {
    client.capabilities.inlayHintProvider = { resolveProvider: true };
    expect(await resolveInlayHint(client, hint)).toBe(true);
    expect(client.request).toHaveBeenCalledOnceWith("inlayHint/resolve", hint);
  });
  it("uses dynamically registered resolve support", async () => {
    client.capabilities.inlayHintProvider = { resolveProvider: false };
    client.registrations.push({
      method: "textDocument/inlayHint",
      registerOptions: { resolveProvider: true },
    });
    expect(await resolveInlayHint(client, hint)).toBe(true);
    expect(client.request).toHaveBeenCalledOnceWith("inlayHint/resolve", hint);
  });
  it("does not request optional resolution when it is unadvertised", async () => {
    for (const provider of [undefined, false, true, {}, { resolveProvider: false }]) {
      client.capabilities.inlayHintProvider = provider;
      expect(await resolveInlayHint(client, hint)).toBe(false);
    }
    expect(client.request).not.toHaveBeenCalled();
  });
  it("honours a dynamic registration that does not provide resolution", async () => {
    client.capabilities.inlayHintProvider = { resolveProvider: true };
    client.registrations.push({
      method: "textDocument/inlayHint",
      registerOptions: { resolveProvider: true },
    });
    client.registrations.push({ method: "textDocument/inlayHint" });
    expect(await resolveInlayHint(client, hint)).toBe(false);
    expect(client.request).not.toHaveBeenCalled();
  });
  it("fails when an advertised resolve request rejects or returns no hint", async () => {
    client.capabilities.inlayHintProvider = { resolveProvider: true };
    const error = Object.assign(new Error("method not found: inlayHint/resolve"), { code: -32601 });
    client.request.and.rejectWith(error);
    await expectAsync(resolveInlayHint(client, hint)).toBeRejectedWith(error);
    client.request.and.resolveTo(null);
    await expectAsync(resolveInlayHint(client, hint)).toBeRejectedWithError(/no usable result/);
  });
});
