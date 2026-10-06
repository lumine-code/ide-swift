const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createProject, prepareProject, removeProject, position } = require("./helpers/project");
const { serverPath, toolchainPath, liveSuite } = require("./helpers/environment");
const until = async (check, label) => {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  throw new Error(`${label} timed out`);
};
liveSuite("ide-swift real editor routing and process ownership", () => {
  let directory, editor, service, clientMain, previousPaths, timeout, diagnostics, edge;
  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 240000;
  });
  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });
  beforeEach(async () => {
    jasmine.useRealClock();
    previousPaths = lumine.project.getPaths();
    directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ide-swift-editor-"));
    lumine.config.set("ide-swift.serverPath", serverPath);
    lumine.config.set("ide-swift.toolchainPath", toolchainPath);
    for (const name of ["language-swift", "ide-client", "ide-swift"])
      await lumine.packages.activatePackage(name);
    clientMain = lumine.packages.getActivePackage("ide-client").mainModule;
    service = clientMain.provideIdeClient();
    diagnostics = [];
    edge = service.onDidPublishDiagnostics((event) => diagnostics.push(event));
  });
  afterEach(async () => {
    edge?.dispose();
    editor?.destroy();
    for (const name of ["ide-swift", "ide-client", "language-swift"])
      await lumine.packages.deactivatePackage(name);
    for (const key of ["serverPath", "toolchainPath", "features"])
      lumine.config.unset(`ide-swift.${key}`);
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    await removeProject(directory);
    editor = null;
  });
  const open = async (fixture) => {
    lumine.project.setPaths([directory]);
    editor = await lumine.workspace.open(fixture.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.swift"));
    const session = await until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-swift",
        ),
      "Swift editor session",
    );
    editor.setText(fixture.text);
    return session;
  };
  it("routes real providers and applies compiler actions and UTF-16 workspace edits", async () => {
    const fixture = createProject(directory);
    await prepareProject(fixture, serverPath, toolchainPath);
    const session = await open(fixture);
    await until(
      () =>
        diagnostics.some(({ diagnostics: items }) =>
          items.some(({ message }) => message.includes("missingName")),
        ),
      "Swift compiler diagnostics",
    );
    const Point = require("lumine").Point;
    const at = (fragment, inside = 0) => {
      const p = position(editor.getText(), fragment, inside);
      return new Point(p.line, p.character);
    };
    const suggestions = await clientMain.provideAutocomplete().getSuggestions({
      editor,
      bufferPosition: at("double(value: 3)", 3),
      prefix: "dou",
      activatedManually: true,
    });
    expect(
      suggestions.some((item) =>
        (item.displayText || item.text || item.snippet || "").includes("double"),
      ),
    ).toBe(true);
    expect(
      (await clientMain.provideContextHelp().getHelp(editor, at("double(value: 3)", 1))).contents
        .value,
    ).toContain("Returns twice");
    expect(
      (await clientMain.provideHoverSignature().getSignature(editor, at("double(value: 3)", 14)))
        .signatures[0].label,
    ).toContain("value: Int");
    const documentProvider = clientMain.provideDocumentSymbolProvider();
    const source = documentProvider
      .getDocumentSymbolSources(editor)
      .find(({ id }) => id === "ide-client:ide-swift");
    expect(source.state).toBe("ready");
    const symbols = await documentProvider.getDocumentSymbols(editor, { sourceId: source.id });
    expect(symbols.some(({ name }) => name === "double(value:)")).toBe(true);
    await until(
      async () =>
        (await clientMain.provideWorkspaceSymbolProvider().searchWorkspaceSymbols("double")).some(
          ({ name }) => name === "double(value:)",
        ),
      "Swift project symbols",
    );
    editor.setCursorBufferPosition(at("triple(value: 3)", 1));
    expect(
      (await clientMain.provideDefinitionProvider().getDefinitions(editor)).some(
        ({ path: target }) => target?.toLowerCase() === fixture.supportPath.toLowerCase(),
      ),
    ).toBe(true);
    editor.setCursorBufferPosition(at("double(value: 3)", 1));
    expect(
      (await clientMain.provideFindReferences().findReferences(editor, at("double(value: 3)", 1)))
        .references.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (
        await clientMain.provideInlayHints().inlayHints(editor, [0, editor.getLastBufferRow()])
      ).some(({ label }) => label.includes("Int")),
    ).toBe(true);
    expect(
      (await clientMain.provideSemanticTokens().semanticTokens(editor)).length,
    ).toBeGreaterThan(0);
    expect(
      (await clientMain.provideCodeFormatFile().formatEntireFile(editor)).length,
    ).toBeGreaterThan(0);
    expect(session.supports("textDocument/codeLens", editor)).toBe(false);
    const rename = await clientMain
      .provideRefactor()
      .rename(editor, at("double(value: 3)", 1), "twice", { dryRun: true });
    expect(rename.outcome).toBe("edits");
    const edits = [...rename.edits.values()].flat();
    expect(
      await service.applyWorkspaceEdit(
        {
          changes: {
            [fixture.uri]: edits.map(({ oldRange, newText }) => ({
              range: {
                start: { line: oldRange[0][0], character: oldRange[0][1] },
                end: { line: oldRange[1][0], character: oldRange[1][1] },
              },
              newText,
            })),
          },
        },
        "Rename Swift symbol",
        session,
      ),
    ).toBe(true);
    expect(editor.getText()).toContain('"😀"; let result = Calculator.twice(value: 3)');
    const actions = await clientMain
      .provideIntentionsList()
      .getIntentions({ textEditor: editor, bufferPosition: at("let emoji", 4) });
    const fix = actions.find(({ title }) => title.includes("Replace 'let emoji'"));
    expect(fix).toBeDefined();
    await fix.selected();
    expect(editor.getText()).toContain('_ = "😀"');
    editor.setText(editor.getText().replace("missingName()", "Calculator.twice(value: 1)"));
    await until(() => {
      const latest = diagnostics.filter(({ session: owner }) => owner === session).at(-1);
      return latest && !latest.diagnostics.some(({ message }) => message.includes("missingName"));
    }, "compiler diagnostic clearing");
  });
  it("honours every advertised feature gate and reattaches after awaited unload", async () => {
    const fixture = createProject(directory);
    await prepareProject(fixture, serverPath, toolchainPath);
    const session = await open(fixture);
    await until(
      () =>
        diagnostics.some(({ diagnostics: items }) =>
          items.some(({ message }) => message.includes("missingName")),
        ),
      "Swift diagnostics before gates",
    );
    for (const [feature, method] of [
      ["diagnostics", "textDocument/diagnostic"],
      ["autocomplete", "textDocument/completion"],
      ["hover", "textDocument/hover"],
      ["signature", "textDocument/signatureHelp"],
      ["definition", "textDocument/definition"],
      ["references", "textDocument/references"],
      ["symbols", "textDocument/documentSymbol"],
      ["format", "textDocument/formatting"],
      ["rename", "textDocument/rename"],
      ["codeActions", "textDocument/codeAction"],
      ["inlayHints", "textDocument/inlayHint"],
      ["semanticTokens", "textDocument/semanticTokens"],
      ["callHierarchy", "textDocument/prepareCallHierarchy"],
      ["typeHierarchy", "textDocument/prepareTypeHierarchy"],
    ]) {
      lumine.config.set(`ide-swift.features.${feature}`, false);
      expect(await service.activeSessionForFeature(editor, method)).toBeNull();
      lumine.config.unset(`ide-swift.features.${feature}`);
      expect(await service.activeSessionForFeature(editor, method)).toBe(session);
    }
    const previous = lumine.packages.getActivePackage("ide-swift").mainModule;
    await lumine.packages.deactivatePackage("ide-swift");
    await until(() => session.state === "stopped", "Swift teardown");
    expect(service.adaptersForEditor(editor)).toEqual([]);
    await lumine.packages.unloadPackage("ide-swift");
    lumine.packages.loadPackage("ide-swift");
    const pkg = await lumine.packages.activatePackage("ide-swift");
    expect(pkg.mainModule).not.toBe(previous);
    const replacement = await until(
      async () =>
        (await service.activeSessionsForEditor(editor)).find(
          ({ adapter }) => adapter.id === "ide-swift",
        ),
      "Swift new generation",
    );
    expect(replacement).not.toBe(session);
  });
  it("stops a cold SwiftPM indexing session through the actual hub and releases its project", async () => {
    const fixture = createProject(directory);
    const session = await open(fixture);
    await until(
      () => /Preparing|Indexing/.test(service.getLog("ide-swift")),
      "cold SwiftPM work started",
    );
    const start = Date.now();
    await service.stop(session);
    expect(session.state).toBe("stopped");
    expect(Date.now() - start).toBeLessThan(15000);
    editor.destroy();
    editor = null;
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
  });
});
