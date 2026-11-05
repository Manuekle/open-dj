/* electron-builder afterPack hook: copies the Next.js standalone server into Contents/Resources/server before the app
   is signed. Not an extraResources entry, because electron-builder always drops node_modules from those. */
const { cpSync, rmSync } = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const target = path.join(app, "Contents", "Resources", "server");
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(context.packager.projectDir, ".next", "standalone"), target, { recursive: true, verbatimSymlinks: true });
};
