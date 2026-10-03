const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { run } = require("./server");

const RELEASES = "https://www.swift.org/api/v1/install/releases.json";
const FINGERPRINT = "52bb7e3de28a71be22ec05ffef80a866b47a981f";
const KEY_URL = "https://www.swift.org/keys/release-key-swift-6.x.asc";
const VERSION = /^6\.\d+\.\d+$/;
// The trust anchor is published independently at https://www.swift.org/keys/active/.
exports.signingFingerprint = FINGERPRINT;
exports.fetchText = async (url) => {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["www.swift.org", "download.swift.org", "raw.githubusercontent.com"].includes(parsed.hostname)
  )
    throw new Error("Unexpected Swift distribution metadata URL.");
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Swift metadata returned HTTP ${response.status}.`);
  return response.text();
};
exports.latestServerVersion = async () => {
  const releases = JSON.parse(await exports.fetchText(RELEASES));
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
exports.verifyPgp = async (archive, signature, armoredKey) => {
  const openpgp = require("openpgp");
  const key = await openpgp.readKey({ armoredKey });
  if (key.getFingerprint() !== FINGERPRINT)
    throw new Error("Swift release signing key does not match its pinned official fingerprint.");
  const signed = await openpgp.readSignature({ armoredSignature: signature });
  const message = await openpgp.createMessage({
    binary: Readable.toWeb(fs.createReadStream(archive)),
  });
  const verified = await openpgp.verify({ message, signature: signed, verificationKeys: key });
  if (verified.signatures.length !== 1)
    throw new Error("Swift distribution must have one valid release signature.");
  // Consume the streamed content before awaiting its final signature result.
  for await (const _chunk of Readable.fromWeb(verified.data)) {
    /* Verification hashes the full archive. */
  }
  await verified.signatures[0].verified;
  return FINGERPRINT;
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
exports.installServer = async ({ storagePath, version, api }) => {
  const selected = version || (await exports.latestServerVersion());
  if (!VERSION.test(selected))
    throw new Error("Choose a stable Swift 6.x release version including its patch number.");
  await fs.promises.mkdir(storagePath, { recursive: true });
  const provenance = path.join(storagePath, "provenance");
  await fs.promises.mkdir(provenance, { recursive: true });
  await fs.promises.writeFile(
    path.join(provenance, "Swift-LICENSE.txt"),
    await exports.fetchText("https://www.swift.org/LICENSE.txt"),
  );
  await fs.promises.writeFile(
    path.join(provenance, "Swift-CONTRIBUTORS.txt"),
    await exports.fetchText("https://www.swift.org/CONTRIBUTORS.txt"),
  );
  let binary, distribution, integrity;
  api.setServerInstallationStatus("checking");
  if (process.platform === "win32") {
    const manifest = await exports.fetchText(
      `https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/s/Swift/Toolchain/${selected}/Swift.Toolchain.installer.yaml`,
    );
    distribution = exports.windowsDistribution(manifest, selected);
    await fs.promises.writeFile(path.join(provenance, "winget-installer.yaml"), manifest);
    const archive = path.join(storagePath, ".swift-installer.exe");
    api.setServerInstallationStatus("downloading");
    await api.downloadFile(distribution.url, archive, {
      type: "uncompressed",
      digest: distribution.digest,
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
      { timeout: 60000 },
    );
    await fs.promises.writeFile(path.join(provenance, "swift-authenticode.json"), authenticode);
    const helper = await api.githubReleaseByTag("activescott/lessmsi", "v2.12.9");
    const asset = helper.assets.find((entry) => entry.name === "lessmsi-v2.12.9.zip");
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset?.digest || ""))
      throw new Error("lessmsi publishes no verified extraction helper.");
    const tools = path.join(storagePath, "tools", "lessmsi");
    await api.downloadFile(asset.url, tools, { type: "zip", digest: asset.digest });
    const lessmsi = await locate(tools, "lessmsi.exe");
    if (!lessmsi) throw new Error("Swift extraction helper contains no lessmsi executable.");
    api.setServerInstallationStatus("installing");
    binary = await require("./windows-bundle").extract(archive, storagePath, lessmsi);
    await fs.promises.unlink(archive);
    integrity = { checksum: distribution.digest, helperChecksum: asset.digest };
  } else if (process.platform === "linux") {
    const url = exports.linuxDistribution(
      selected,
      await fs.promises.readFile("/etc/os-release", "utf8"),
    );
    const archive = path.join(storagePath, ".swift-toolchain.tar.gz");
    api.setServerInstallationStatus("downloading");
    await api.downloadFile(url, archive, { type: "uncompressed" });
    const signature = await exports.fetchText(url + ".sig");
    const key = await exports.fetchText(KEY_URL);
    await exports.verifyPgp(archive, signature, key);
    await fs.promises.writeFile(path.join(provenance, "swift-toolchain.tar.gz.sig"), signature);
    await fs.promises.writeFile(path.join(provenance, "swift-release-key.asc"), key);
    api.setServerInstallationStatus("installing");
    await run("tar", ["-xzf", archive, "-C", storagePath], { timeout: 300000 });
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
    await api.downloadFile(url, archive, { type: "uncompressed" });
    const signature = await run("/usr/sbin/pkgutil", ["--check-signature", archive]);
    if (
      !signature.includes("signed by a developer certificate issued by Apple") ||
      !signature.includes("Swift")
    )
      throw new Error(
        "Swift package does not have the expected trusted Swift developer signature.",
      );
    await fs.promises.writeFile(path.join(provenance, "swift-package-signature.txt"), signature);
    api.setServerInstallationStatus("installing");
    await run("/usr/sbin/pkgutil", ["--expand-full", archive, path.join(storagePath, "sdk")], {
      timeout: 300000,
    });
    await fs.promises.unlink(archive);
    const executable = await locate(storagePath, "sourcekit-lsp");
    if (!executable) throw new Error("Swift package contains no SourceKit-LSP.");
    binary = path.relative(storagePath, executable);
    distribution = { url };
    integrity = { signature: "Apple Developer ID" };
  } else throw new Error(`Swift has no supported toolchain for ${process.platform}.`);
  const digest = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(path.join(storagePath, binary)))
    digest.update(chunk);
  return {
    version: selected,
    binary,
    distribution: distribution.url,
    ...integrity,
    binaryChecksum: `sha256:${digest.digest("hex")}`,
  };
};
