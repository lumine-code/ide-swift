const { findOnPath } = require("./server-resolution");
const serverPath = process.env.SWIFT_SERVER_PATH || findOnPath("sourcekit-lsp");
if (process.env.REQUIRE_SOURCEKIT && !serverPath)
  throw new Error("CI requires a real matched Swift toolchain and SourceKit-LSP.");
module.exports = {
  serverPath,
  toolchainPath: process.env.SWIFT_TOOLCHAIN_PATH || "",
  liveSuite: serverPath ? describe : () => {},
};
