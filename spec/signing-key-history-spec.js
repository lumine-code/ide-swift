const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const requireCurrent = createRequire(__filename);

describe("Swift signing key certificate history", () => {
  let openpgp, original, renewed, foreign, signature, bytes, key, installer, directory, archive;
  beforeAll(async () => {
    openpgp = await import("openpgp");
    const now = Math.floor(Date.now() / 1000) * 1000;
    const day = 24 * 60 * 60;
    original = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519",
      userIDs: [{ name: "Swift renewed certificate fixture" }],
      date: new Date(now - 2 * 365 * day * 1000),
      keyExpirationTime: 2 * 365 * day,
    });
    const privateKey = await openpgp.readPrivateKey({ armoredKey: original.privateKey });
    bytes = new Uint8Array([0, 255, 13, 10, 128, 0, 65]);
    signature = await openpgp.sign({
      message: await openpgp.createMessage({ binary: bytes }),
      signingKeys: privateKey,
      date: new Date(now - 30 * day * 1000),
      detached: true,
    });
    renewed = await openpgp.reformatKey({
      privateKey,
      userIDs: [{ name: "Swift renewed certificate fixture" }],
      date: new Date(now - day * 1000),
      keyExpirationTime: 4 * 365 * day,
    });
    foreign = await openpgp.generateKey({
      type: "ecc",
      curve: "ed25519",
      userIDs: [{ name: "Unrelated signing key fixture" }],
    });
  }, 30000);
  beforeEach(async () => {
    await lumine.packages.activatePackage("ide-swift");
    installer = requireCurrent("../lib/installer");
    key = await openpgp.readKey({ armoredKey: renewed.publicKey });
    directory = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), "swift-key-history-"),
    );
    archive = path.join(directory, "signed-data.bin");
    fs.writeFileSync(archive, bytes);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("ide-swift");
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  it("refuses a certificate issued after the release signature", async () => {
    expect(openpgp.config.allowInsecureVerificationWithReformattedKeys).toBe(false);
    await expectAsync(installer.verifyPgpData(archive, signature, key)).toBeRejectedWithError(
      /creation time is in the future/,
    );
  });
  it("verifies the release using its earlier certificate while retaining the renewed expiry", async () => {
    const expiry = await key.getExpirationTime();
    const merged = await installer.mergeSigningKeyHistory(
      key,
      renewed.publicKey + original.publicKey,
    );
    expect(merged.getFingerprint()).toBe(key.getFingerprint());
    expect(await merged.getExpirationTime()).toEqual(expiry);
    expect(merged.users[0].selfCertifications.length).toBe(2);
    await installer.verifyPgpData(archive, signature, merged);
  });
  it("reads separate armored blocks and refuses to substitute an unrelated key", async () => {
    const merged = await installer.mergeSigningKeyHistory(
      key,
      foreign.publicKey + original.publicKey,
    );
    expect(merged.getFingerprint()).toBe(key.getFingerprint());
    await installer.verifyPgpData(archive, signature, merged);
    await expectAsync(
      installer.mergeSigningKeyHistory(key, foreign.publicKey),
    ).toBeRejectedWithError(/no matching certificate/);
  });
  it("retains revocations when adding an earlier certificate", async () => {
    const revoked = await key.applyRevocationCertificate(original.revocationCertificate);
    const merged = await installer.mergeSigningKeyHistory(revoked, original.publicKey);
    expect(merged.revocationSignatures.length).toBe(revoked.revocationSignatures.length);
    await expectAsync(installer.verifyPgpData(archive, signature, merged)).toBeRejected();
  });
  it("still rejects modified distribution bytes after recovering its certificate", async () => {
    const merged = await installer.mergeSigningKeyHistory(key, original.publicKey);
    fs.appendFileSync(archive, new Uint8Array([1]));
    await expectAsync(installer.verifyPgpData(archive, signature, merged)).toBeRejected();
  });
  it("keeps the official fingerprint pinned even when foreign certificate history is supplied", async () => {
    spyOn(installer, "fetchText");
    const source = spyOn(fs, "createReadStream").and.callThrough();
    await expectAsync(
      installer.verifyPgp(archive, signature, renewed.publicKey, {
        keyHistory: original.publicKey,
      }),
    ).toBeRejectedWithError(/pinned official fingerprint/);
    expect(installer.fetchText).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });
});
