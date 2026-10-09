const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { run } = require("./server");

const RELEASES = "https://www.swift.org/api/v1/install/releases.json";
const FINGERPRINT = "52bb7e3de28a71be22ec05ffef80a866b47a981f";
const KEY_URL = "https://www.swift.org/keys/release-key-swift-6.x.asc";
const VERSION = /^6\.\d+\.\d+$/;
// The trust anchor is published independently at https://www.swift.org/keys/active/.
exports.signingFingerprint = FINGERPRINT;
exports.fetchText = async (url, { signal: callerSignal } = {}) => {
  callerSignal?.throwIfAborted();
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["www.swift.org", "download.swift.org", "raw.githubusercontent.com"].includes(parsed.hostname)
  )
    throw new Error("Unexpected Swift distribution metadata URL.");
  const timeout = AbortSignal.timeout(30000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    const response = await fetch(url, { signal });
    signal.throwIfAborted();
    if (!response.ok) throw new Error(`Swift metadata returned HTTP ${response.status}.`);
    const text = await response.text();
    signal.throwIfAborted();
    return text;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
};
exports.latestServerVersion = async ({ signal } = {}) => {
  const releases = JSON.parse(await exports.fetchText(RELEASES, { signal }));
  const version = releases.filter((entry) => VERSION.test(entry.name || "")).at(-1)?.name;
  if (!version) throw new Error("Swift publishes no supported stable 6.x toolchain.");
  return version;
};
exports.windowsDistribution = (yaml, version, arch = process.arch) => {
  const architecture = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!architecture) throw new Error(`Swift publishes no Windows toolchain for ${arch}.`);
  const sections = yaml.split(/(?=^- Architecture:)/m);
  const section = sections.find(
    (entry) =>
      entry.startsWith(`- Architecture: ${architecture}\n`) ||
      entry.startsWith(`- Architecture: ${architecture}\r\n`),
  );
  const url = section?.match(/^ {2}InstallerUrl: (\S+)\s*$/m)?.[1];
  const checksum = section?.match(/^ {2}InstallerSha256: ([a-f0-9]{64})\s*$/im)?.[1];
  const target = architecture === "x64" ? "windows10" : "windows10-arm64";
  const expected = `https://download.swift.org/swift-${version}-release/${target}/swift-${version}-RELEASE/swift-${version}-RELEASE-${target}.exe`;
  if (url !== expected || !checksum)
    throw new Error("WinGet did not publish the exact official Swift installer and SHA256 hash.");
  return { url, digest: `sha256:${checksum.toLowerCase()}` };
};
exports.linuxDistribution = (version, osRelease, arch = process.arch) => {
  if (!["x64", "arm64"].includes(arch))
    throw new Error(`Swift publishes no Linux toolchain for ${arch}.`);
  const values = Object.fromEntries(
    osRelease.split(/\r?\n/).flatMap((line) => {
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      return match ? [[match[1], match[2].replace(/^"|"$/g, "")]] : [];
    }),
  );
  const targets = {
    "ubuntu:22.04": ["ubuntu2204", "ubuntu22.04"],
    "ubuntu:24.04": ["ubuntu2404", "ubuntu24.04"],
    "ubuntu:26.04": ["ubuntu2604", "ubuntu26.04"],
    "debian:12": ["debian12", "debian12"],
    "debian:13": ["debian13", "debian13"],
    "fedora:41": ["fedora41", "fedora41"],
    "amzn:2023": ["amazonlinux2023", "amazonlinux2023"],
  };
  const target = targets[`${values.ID}:${values.VERSION_ID}`];
  if (!target)
    throw new Error(
      `Swift managed toolchains do not match '${values.ID} ${values.VERSION_ID}'. Install Swift for your distribution and select its toolchain.`,
    );
  const suffix = arch === "arm64" ? "-aarch64" : "";
  return `https://download.swift.org/swift-${version}-release/${target[0]}${suffix}/swift-${version}-RELEASE/swift-${version}-RELEASE-${target[1]}${suffix}.tar.gz`;
};
exports.verifyPgp = async (archive, signature, armoredKey, { signal } = {}) => {
  signal?.throwIfAborted();
  const openpgp = require("openpgp");
  const key = await openpgp.readKey({ armoredKey });
  if (key.getFingerprint() !== FINGERPRINT)
    throw new Error("Swift release signing key does not match its pinned official fingerprint.");
  await exports.verifyPgpData(archive, signature, key, { signal });
  return FINGERPRINT;
};
exports.verifyPgpData = async (archive, signature, key, { signal } = {}) => {
  signal?.throwIfAborted();
  const openpgp = require("openpgp");
  const signed = await openpgp.readSignature({ armoredSignature: signature });
  const source = fs.createReadStream(archive, { signal });
  const chunks = source[Symbol.asyncIterator]();
  // Electron exposes browser streams alongside Node's stream/web realm. Keep
  // OpenPGP's input and its derived streams in the editor's own WebStream realm.
  const binary = new ReadableStream({
    async pull(controller) {
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(new Uint8Array(value));
    },
    async cancel() {
      await chunks.return();
    },
  });
  try {
    const message = await openpgp.createMessage({ binary });
    const verified = await openpgp.verify({
      message,
      signature: signed,
      verificationKeys: key,
      format: "binary",
    });
    if (verified.signatures.length !== 1)
      throw new Error("Swift distribution must have one valid release signature.");
    // Consume all bytes before awaiting the streamed signature result.
    const reader = verified.data.getReader();
    try {
      while (!(await reader.read()).done) {
        signal?.throwIfAborted();
      }
    } finally {
      reader.releaseLock();
    }
    await verified.signatures[0].verified;
    signal?.throwIfAborted();
  } finally {
    await new Promise((resolve) => {
      if (source.closed) resolve();
      else {
        source.once("close", resolve);
        source.destroy();
      }
    });
  }
};
const locate = async (directory, name, depth = 8) => {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory() && depth > 0) {
      const nested = await locate(file, name, depth - 1);
      if (nested) return nested;
    }
  }
  return null;
};
exports.installServer = async ({ storagePath, version, api, signal: callerSignal }) => {
  const signal =
    callerSignal && api.signal
      ? AbortSignal.any([callerSignal, api.signal])
      : callerSignal || api.signal;
  signal?.throwIfAborted();
  const selected = version || (await exports.latestServerVersion({ signal }));
  signal?.throwIfAborted();
  if (!VERSION.test(selected))
    throw new Error("Choose a stable Swift 6.x release version including its patch number.");
  await fs.promises.mkdir(storagePath, { recursive: true });
  signal?.throwIfAborted();
  const provenance = path.join(storagePath, "provenance");
  await fs.promises.mkdir(provenance, { recursive: true });
  signal?.throwIfAborted();
  await fs.promises.writeFile(
    path.join(provenance, "Swift-LICENSE.txt"),
    await exports.fetchText("https://www.swift.org/LICENSE.txt", { signal }),
    { signal },
  );
  await fs.promises.writeFile(
    path.join(provenance, "Swift-CONTRIBUTORS.txt"),
    await exports.fetchText("https://www.swift.org/CONTRIBUTORS.txt", { signal }),
    { signal },
  );
  let binary, distribution, integrity;
  api.setServerInstallationStatus("checking");
  signal?.throwIfAborted();
  if (process.platform === "win32") {
    const manifest = await exports.fetchText(
      `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/s/Swift/Toolchain/${selected}/Swift.Toolchain.installer.yaml`,
      { signal },
    );
    distribution = exports.windowsDistribution(manifest, selected);
    await fs.promises.writeFile(path.join(provenance, "winget-installer.yaml"), manifest, {
      signal,
    });
    const archive = path.join(storagePath, ".swift-installer.exe");
    api.setServerInstallationStatus("downloading");
    signal?.throwIfAborted();
    await api.downloadFile(distribution.url, archive, {
      type: "uncompressed",
      digest: distribution.digest,
      signal,
    });
    const authenticode = await run(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(__dirname, "verify-windows-signature.ps1"),
        "-Path",
        archive,
      ],
      { timeout: 60000, signal },
    );
    await fs.promises.writeFile(path.join(provenance, "swift-authenticode.json"), authenticode, {
      signal,
    });
    const helper = await api.githubReleaseByTag("activescott/lessmsi", "v2.12.9", { signal });
    const asset = helper.assets.find((entry) => entry.name === "lessmsi-v2.12.9.zip");
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset?.digest || ""))
      throw new Error("lessmsi publishes no verified extraction helper.");
    const tools = path.join(storagePath, "tools", "lessmsi");
    await api.downloadFile(asset.url, tools, { type: "zip", digest: asset.digest, signal });
    const lessmsi = await locate(tools, "lessmsi.exe");
    if (!lessmsi) throw new Error("Swift extraction helper contains no lessmsi executable.");
    api.setServerInstallationStatus("installing");
    signal?.throwIfAborted();
    binary = await require("./windows-bundle").extract(archive, storagePath, lessmsi, { signal });
    await fs.promises.unlink(archive);
    integrity = { checksum: distribution.digest, helperChecksum: asset.digest };
  } else if (process.platform === "linux") {
    const url = exports.linuxDistribution(
      selected,
      await fs.promises.readFile("/etc/os-release", "utf8"),
    );
    const archive = path.join(storagePath, ".swift-toolchain.tar.gz");
    api.setServerInstallationStatus("downloading");
    signal?.throwIfAborted();
    await api.downloadFile(url, archive, { type: "uncompressed", signal });
    const signature = await exports.fetchText(url + ".sig", { signal });
    const key = await exports.fetchText(KEY_URL, { signal });
    await exports.verifyPgp(archive, signature, key, { signal });
    await fs.promises.writeFile(path.join(provenance, "swift-toolchain.tar.gz.sig"), signature, {
      signal,
    });
    await fs.promises.writeFile(path.join(provenance, "swift-release-key.asc"), key, { signal });
    api.setServerInstallationStatus("installing");
    await run("tar", ["-xzf", archive, "-C", storagePath], { timeout: 300000, signal });
    await fs.promises.unlink(archive);
    const executable = await locate(storagePath, "sourcekit-lsp");
    if (!executable) throw new Error("Swift archive contains no SourceKit-LSP.");
    binary = path.relative(storagePath, executable);
    distribution = { url };
    integrity = { signingFingerprint: FINGERPRINT };
  } else if (process.platform === "darwin") {
    const url = `https://download.swift.org/swift-${selected}-release/xcode/swift-${selected}-RELEASE/swift-${selected}-RELEASE-osx.pkg`;
    const archive = path.join(storagePath, ".swift-toolchain.pkg");
    api.setServerInstallationStatus("downloading");
    signal?.throwIfAborted();
    await api.downloadFile(url, archive, { type: "uncompressed", signal });
    const signature = await run("/usr/sbin/pkgutil", ["--check-signature", archive], { signal });
    if (
      !signature.includes("signed by a developer certificate issued by Apple") ||
      !signature.includes("Swift")
    )
      throw new Error(
        "Swift package does not have the expected trusted Swift developer signature.",
      );
    await fs.promises.writeFile(path.join(provenance, "swift-package-signature.txt"), signature, {
      signal,
    });
    api.setServerInstallationStatus("installing");
    await run("/usr/sbin/pkgutil", ["--expand-full", archive, path.join(storagePath, "sdk")], {
      timeout: 300000,
      signal,
    });
    await fs.promises.unlink(archive);
    const executable = await locate(storagePath, "sourcekit-lsp");
    if (!executable) throw new Error("Swift package contains no SourceKit-LSP.");
    binary = path.relative(storagePath, executable);
    distribution = { url };
    integrity = { signature: "Apple Developer ID" };
  } else throw new Error(`Swift has no supported toolchain for ${process.platform}.`);
  signal?.throwIfAborted();
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(path.join(storagePath, binary), { signal }))
    digest.update(chunk);
  signal?.throwIfAborted();
  return {
    version: selected,
    binary,
    distribution: distribution.url,
    ...integrity,
    binaryChecksum: `sha256:${digest.digest("hex")}`,
  };
};
