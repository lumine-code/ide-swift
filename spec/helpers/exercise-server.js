const assert = require("node:assert/strict");
const { fileURLToPath } = require("node:url");
const { position } = require("./project");
const sameFile = (uri, file) =>
  uri?.startsWith("file:") && fileURLToPath(uri).toLowerCase() === file.toLowerCase();
const flatten = (items) => items.flatMap((item) => [item, ...flatten(item.children || [])]);
const editsOf = (edit) => [
  ...Object.values(edit?.changes || {}).flat(),
  ...(edit?.documentChanges || []).flatMap((item) => item.edits || []),
];
const applyEdits = (text, edits) => {
  const offset = ({ line, character }) =>
    text
      .split("\n")
      .slice(0, line)
      .reduce((value, part) => value + part.length + 1, 0) + character;
  return edits
    .map((edit) => ({ ...edit, start: offset(edit.range.start), end: offset(edit.range.end) }))
    .sort((a, b) => b.start - a.start)
    .reduce(
      (value, edit) => value.slice(0, edit.start) + edit.newText + value.slice(edit.end),
      text,
    );
};
const at = (client, fixture, method, fragment, inside = 0, extra = {}) =>
  client.request(method, {
    textDocument: { uri: fixture.uri },
    position: position(fixture.text, fragment, inside),
    ...extra,
  });
const exerciseServer = async (client, fixture) => {
  const covered = [];
  const check = (name, value) => {
    assert.ok(value, `${name} has no usable result`);
    covered.push(name);
  };
  client.open(fixture.uri, "swift", fixture.text);
  const report = await client.waitFor(
    async () => {
      const value = await client.request("textDocument/diagnostic", {
        textDocument: { uri: fixture.uri },
      });
      return value.items?.some(({ message }) => message.includes("missingName")) ? value : null;
    },
    "Swift compiler diagnostics",
    90000,
  );
  check(
    "diagnostics",
    report.items.some(({ message }) => message.includes("missingName")),
  );
  check(
    "dynamic registrations",
    client.registrations.some(({ method }) => method === "textDocument/semanticTokens"),
  );
  const completions = await at(client, fixture, "textDocument/completion", "double(value: 3)", 3);
  const item = (completions.items || completions).find(({ label }) => label.startsWith("double("));
  check("completion", item);
  check(
    "completion resolve",
    JSON.stringify(await client.request("completionItem/resolve", item)).includes("twice"),
  );
  check(
    "hover",
    JSON.stringify(await at(client, fixture, "textDocument/hover", "double(value: 3)", 1)).includes(
      "Returns twice",
    ),
  );
  const signature = await at(client, fixture, "textDocument/signatureHelp", "double(value: 3)", 14);
  check(
    "signature",
    signature.signatures.some(({ label }) => label.includes("value: Int")),
  );
  check(
    "definition",
    (await at(client, fixture, "textDocument/definition", "double(value: 3)", 1)).some((item) =>
      sameFile(item.uri || item.targetUri, fixture.filePath),
    ),
  );
  check(
    "module definition",
    (await at(client, fixture, "textDocument/definition", "triple(value: 3)", 1)).some((item) =>
      sameFile(item.uri || item.targetUri, fixture.supportPath),
    ),
  );
  const refs = await client.waitFor(
    async () => {
      const value = await at(client, fixture, "textDocument/references", "double(value: Int)", 1, {
        context: { includeDeclaration: true },
      });
      return value.length >= 2 ? value : null;
    },
    "Swift index references",
    90000,
  );
  check("references", refs.length >= 2);
  const rename = await at(client, fixture, "textDocument/rename", "double(value: 3)", 1, {
    newName: "twice",
  });
  const renamed = applyEdits(fixture.text, editsOf(rename));
  check(
    "UTF-16 rename",
    renamed.includes('"😀"; let result = Calculator.twice(value: 3)') &&
      renamed.includes("func twice(value: Int)"),
  );
  check(
    "document symbols",
    flatten(
      await client.request("textDocument/documentSymbol", { textDocument: { uri: fixture.uri } }),
    ).some(({ name }) => name === "double(value:)"),
  );
  const symbols = await client.waitFor(
    async () => {
      const value = await client.request("workspace/symbol", { query: "double" });
      return value.some(({ name }) => name === "double(value:)") ? value : null;
    },
    "Swift workspace index",
    90000,
  );
  check("workspace symbols", symbols.length);
  const formatting = await client.request("textDocument/formatting", {
    textDocument: { uri: fixture.uri },
    options: { tabSize: 4, insertSpaces: true },
  });
  check("formatting", formatting.length > 0 && applyEdits(fixture.text, formatting).includes("😀"));
  const unused = report.items.find(({ message }) => message.includes("emoji"));
  assert.ok(unused, "fixture has unused-value quickfix");
  const actions = await client.request("textDocument/codeAction", {
    textDocument: { uri: fixture.uri },
    range: unused.range,
    context: { diagnostics: [unused] },
  });
  const action = actions.find(({ title }) => title.includes("Replace 'let emoji'"));
  if (!action?.edit) throw new Error(`Swift quickfix response: ${JSON.stringify(actions)}`);
  check("code actions", action?.edit);
  check("code action edits", applyEdits(fixture.text, editsOf(action.edit)).includes('_ = "😀"'));
  const hints = await client.request("textDocument/inlayHint", {
    textDocument: { uri: fixture.uri },
    range: {
      start: { line: 0, character: 0 },
      end: { line: fixture.text.split("\n").length - 1, character: 0 },
    },
  });
  check(
    "inlay hints",
    hints.some(({ label }) => JSON.stringify(label).includes("Int")),
  );
  check("inlay hint resolve", await client.request("inlayHint/resolve", hints[0]));
  const tokens = await client.request("textDocument/semanticTokens/full", {
    textDocument: { uri: fixture.uri },
  });
  check("semantic tokens", tokens.data.length > 0 && tokens.data.length % 5 === 0);
  const fn = await at(
    client,
    fixture,
    "textDocument/prepareCallHierarchy",
    "double(value: Int)",
    1,
  );
  const incoming = await client.request("callHierarchy/incomingCalls", { item: fn[0] });
  check(
    "incoming calls",
    incoming.some(({ from }) => from.name.includes("use")),
  );
  const caller = await at(client, fixture, "textDocument/prepareCallHierarchy", "use()", 1);
  const outgoing = await client.request("callHierarchy/outgoingCalls", { item: caller[0] });
  check(
    "outgoing calls",
    outgoing.some(({ to }) => to.name.includes("double")),
  );
  const base = await at(client, fixture, "textDocument/prepareTypeHierarchy", "Adder {", 1);
  const derived = await client.request("typeHierarchy/subtypes", { item: base[0] });
  check(
    "type subtypes",
    derived.some(({ name }) => name === "Calculator"),
  );
  const concrete = await at(client, fixture, "textDocument/prepareTypeHierarchy", "Calculator:", 1);
  const parents = await client.request("typeHierarchy/supertypes", { item: concrete[0] });
  check(
    "type supertypes",
    parents.some(({ name }) => name === "Adder"),
  );
  const repaired = fixture.text.replace("missingName()", "Calculator.double(value: 1)");
  await client.connection.sendNotification("textDocument/didChange", {
    textDocument: { uri: fixture.uri, version: 2 },
    contentChanges: [{ text: repaired }],
  });
  check(
    "diagnostic clearing",
    !(
      await client.request("textDocument/diagnostic", { textDocument: { uri: fixture.uri } })
    ).items.some(({ message }) => message.includes("missingName")),
  );
  return covered;
};
module.exports = { exerciseServer, applyEdits, editsOf, position, sameFile };
