const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { run, toolchainEnvironment } = require("../../lib/server");

const source = `import Support
public protocol Adder { func add(value: Int) -> Int }
public class Calculator: Adder {
 public init() {}
 public func add(value: Int) -> Int { return value + 1 }
 /// Returns twice its input.
 public static func double(value: Int) -> Int { return value * 2 }
 public func use() -> Int {
  let emoji = "😀"; let result = Calculator.double(value: 3)
  return add(value: result)
 }
 public func external() -> Int { return Helper.triple(value: 3) }
 public func broken() { missingName() }
}
`;
const position = (text, fragment, inside = 0) => {
  const index = text.indexOf(fragment);
  if (index < 0) throw new Error(`Fixture has no '${fragment}'.`);
  const lines = text.slice(0, index + inside).split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
};
const createProject = (rootPath) => {
  const filePath = path.join(rootPath, "Sources", "Demo", "Calculator.swift");
  const supportPath = path.join(rootPath, "Sources", "Support", "Helper.swift");
  for (const file of [filePath, supportPath]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "Package.swift"),
    '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "LumineSpec", products: [.library(name: "Demo", targets: ["Demo"])], targets: [.target(name: "Demo", dependencies: ["Support"]), .target(name: "Support")])\n',
  );
  // Build valid disk content for the index, then introduce an unsaved error
  // through didOpen. Navigation can therefore cross a real built module edge.
  fs.writeFileSync(filePath, source.replace("missingName()", "Calculator.double(value: 1)"));
  fs.writeFileSync(
    supportPath,
    "public enum Helper { public static func triple(value: Int) -> Int { value * 3 } }\n",
  );
  fs.writeFileSync(
    path.join(rootPath, ".swift-format"),
    '{"version":1,"indentation":{"spaces":4}}\n',
  );
  return { rootPath, filePath, supportPath, text: source, uri: pathToFileURL(filePath).href };
};
const prepareProject = async (fixture, serverPath, toolchainPath = "") => {
  const env = { ...process.env, ...toolchainEnvironment(serverPath, toolchainPath) };
  const swift = path.join(
    path.dirname(serverPath),
    process.platform === "win32" ? "swift.exe" : "swift",
  );
  await run(swift, ["build"], {
    cwd: fixture.rootPath,
    env,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
};
const removeProject = (rootPath) => {
  const parent = fs.realpathSync.native(os.tmpdir());
  const absolute = path.resolve(rootPath);
  if (path.dirname(absolute) !== parent || !path.basename(absolute).startsWith("ide-swift-"))
    throw new Error("Refusing unsafe Swift fixture cleanup.");
  return fs.promises.rm(absolute, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
};
module.exports = { source, position, createProject, prepareProject, removeProject };
