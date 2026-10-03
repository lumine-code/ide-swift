const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { installServer } = require("../lib/installer");
const [storagePath, version] = process.argv.slice(2);
if (!storagePath || !version)
  throw new Error("Provide the toolchain staging directory and version.");
installServer({
  storagePath,
  version,
  api: {
    setServerInstallationStatus(status) {
      process.stdout.write(`Swift toolchain: ${status}\n`);
    },
    async downloadFile(url, destination, { digest, type }) {
      if (type !== "uncompressed")
        throw new Error("CI installs the Linux archive as verified data.");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Swift download returned ${response.status}`);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
      if (digest) {
        const [algorithm, expected] = digest.split(":");
        const hash = crypto.createHash(algorithm);
        for await (const chunk of fs.createReadStream(destination)) hash.update(chunk);
        if (hash.digest("hex") !== expected) throw new Error("CI archive integrity mismatch");
      }
    },
  },
})
  .then(async (installed) => {
    await fs.promises.writeFile(
      path.join(storagePath, "server-path.txt"),
      path.join(storagePath, installed.binary),
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
