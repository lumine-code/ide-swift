const { findOnPath } = require("./server-resolution");
// Portable CI exercises the adapter and verifier without discovering a runner's
// preinstalled SDK. REQUIRE_SOURCEKIT always keeps the live job mandatory.
const fixtureOnly = process.env.SWIFT_FIXTURE_ONLY === "1" && !process.env.REQUIRE_SOURCEKIT;
const serverPath = fixtureOnly
  ? null
  : process.env.SWIFT_SERVER_PATH || findOnPath("sourcekit-lsp");
if (process.env.REQUIRE_SOURCEKIT && !serverPath)
  throw new Error("CI requires a real matched Swift toolchain and SourceKit-LSP.");
module.exports = {
  serverPath,
  toolchainPath: process.env.SWIFT_TOOLCHAIN_PATH || "",
  liveSuite: serverPath ? describe : () => {},
};
