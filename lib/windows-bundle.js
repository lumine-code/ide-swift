const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { run } = require("./server");

const VERSION = /^\d+\.\d+\.\d+$/;
const resolveInside = (root, relative) => {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw new Error("Unsafe Swift payload path.");
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep))
    throw new Error("Swift payload escapes its staging directory.");
  return file;
};
exports.resolveInside = resolveInside;

// Read the public PE and Burn v2 CAB-container metadata. This is a data reader,
// not an installer invocation; no executable entry point or MSI action runs.
// Layout: https://github.com/wixtoolset/wix/tree/main/src/wix/WixToolset.Core.Burn/Bundles
exports.containers = (header, fileSize) => {
  if (header.length < 64 || header.readUInt16LE(0) !== 0x5a4d)
    throw new Error("Swift installer is not a PE bundle.");
  const pe = header.readUInt32LE(60);
  if (pe + 24 > header.length || header.toString("ascii", pe, pe + 4) !== "PE\0\0")
    throw new Error("Invalid Swift PE header.");
  const sections = header.readUInt16LE(pe + 6);
  const table = pe + 24 + header.readUInt16LE(pe + 20);
  if (sections > 128 || table + sections * 40 > header.length)
    throw new Error("Invalid Swift section table.");
  let burn;
  for (let index = 0; index < sections; index++) {
    const position = table + index * 40;
    if (header.toString("ascii", position, position + 8) === ".wixburn")
      burn = header.readUInt32LE(position + 20);
  }
  if (
    burn === undefined ||
    burn + 52 > header.length ||
    header.readUInt32LE(burn) !== 0x00f14300 ||
    header.readUInt32LE(burn + 4) !== 2 ||
    header.readUInt32LE(burn + 40) !== 1
  )
    throw new Error("Unsupported Swift Burn container format.");
  const count = header.readUInt32LE(burn + 44);
  if (count < 1 || count > 8 || burn + 48 + count * 4 > header.length)
    throw new Error("Invalid Swift container count.");
  const sizes = Array.from({ length: count }, (_, index) =>
    header.readUInt32LE(burn + 48 + index * 4),
  );
  const stub = header.readUInt32LE(burn + 24);
  const signature = header.readUInt32LE(burn + 32);
  let offset = signature ? signature + header.readUInt32LE(burn + 36) : stub + sizes[0];
  const entries = [{ start: stub, size: sizes[0] }];
  for (const size of sizes.slice(1)) {
    entries.push({ start: offset, size });
    offset += size;
  }
  if (entries.some(({ start, size }) => size <= 0 || start < 0 || start + size > fileSize))
    throw new Error("Swift container lies outside the installer.");
  return entries;
};

exports.payloads = (xml) =>
  [...xml.matchAll(/<Payload\b([^>]+)\/>/g)]
    .map((match) =>
      Object.fromEntries(
        [...match[1].matchAll(/\b([A-Za-z]+)="([^"<>]*)"/g)].map(([, key, value]) => [key, value]),
      ),
    )
    .filter((entry) => entry.Packaging === "embedded" && entry.Container);

exports.extract = async (installer, destination, lessmsi, { signal } = {}) => {
  signal?.throwIfAborted();
  const scratch = resolveInside(destination, ".swift-extract");
  const ux = path.join(scratch, "ux");
  const payloadRoot = path.join(scratch, "payloads");
  await fs.promises.mkdir(ux, { recursive: true });
  await fs.promises.mkdir(payloadRoot, { recursive: true });
  const handle = await fs.promises.open(installer, "r");
  let entries;
  try {
    const header = Buffer.alloc(1024 * 1024);
    await handle.read(header, 0, header.length, 0);
    entries = exports.containers(header, (await handle.stat()).size);
  } finally {
    await handle.close();
  }
  const expand = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "expand.exe");
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted();
    const cabinet = path.join(scratch, `container-${index}.cab`);
    await pipeline(
      fs.createReadStream(installer, { start: entry.start, end: entry.start + entry.size - 1 }),
      fs.createWriteStream(cabinet),
      { signal },
    );
    await run(expand, ["-F:*", cabinet, index === 0 ? ux : payloadRoot], {
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
    await fs.promises.unlink(cabinet);
  }
  const xml = await fs.promises.readFile(path.join(ux, "0"), "utf8");
  for (const payload of exports.payloads(xml)) {
    signal?.throwIfAborted();
    if (
      !/^a\d+$/.test(payload.SourcePath) ||
      !/^[a-z0-9.]+\.(?:msi|cab)$/i.test(payload.FilePath) ||
      !/^[0-9a-f]{128}$/i.test(payload.Hash || "")
    )
      throw new Error("Unsafe Swift embedded-payload metadata.");
    const source = resolveInside(payloadRoot, payload.SourcePath);
    const target = resolveInside(payloadRoot, payload.FilePath);
    const crypto = require("node:crypto");
    const hash = crypto.createHash("sha512");
    for await (const chunk of fs.createReadStream(source, { signal })) hash.update(chunk);
    if (hash.digest("hex") !== payload.Hash.toLowerCase())
      throw new Error(`Swift embedded payload '${payload.FilePath}' failed its SHA512 check.`);
    await fs.promises.rename(source, target);
  }
  const extracted = path.join(destination, "sdk");
  const runtime = process.arch === "arm64" ? "rtl.arm64" : "rtl.amd64";
  for (const name of [
    "bld.noasserts",
    "cli.noasserts",
    "ide.noasserts",
    "res",
    runtime,
    "windows",
  ]) {
    const msi = path.join(payloadRoot, `${name}.msi`);
    await fs.promises.access(msi, fs.constants.R_OK);
    // A trailing native separator selects the output directory in lessmsi;
    // without it the argument is interpreted as a requested file name.
    await run(lessmsi, ["xo", msi, extracted + path.sep], {
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
    });
  }
  const root = path.join(extracted, "SourceDir", "LocalApp", "Programs", "Swift");
  const versions = (await fs.promises.readdir(path.join(root, "Toolchains"))).filter(
    (entry) => VERSION.test(entry.replace(/\+NoAsserts$/, "")) && entry.endsWith("+NoAsserts"),
  );
  if (versions.length !== 1)
    throw new Error("Swift bundle does not contain one complete no-asserts toolchain.");
  const binary = path.join(root, "Toolchains", versions[0], "usr", "bin", "sourcekit-lsp.exe");
  await fs.promises.access(binary, fs.constants.R_OK);
  signal?.throwIfAborted();
  await fs.promises.mkdir(path.join(destination, "provenance"), { recursive: true });
  await fs.promises.writeFile(path.join(destination, "provenance", "swift-burn-manifest.xml"), xml);
  await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return path.relative(destination, binary);
};
