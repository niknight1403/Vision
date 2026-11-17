const path = require("node:path");
const fs = require("node:fs");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The shared `@autonomagent/trading-core` package is ESM and is compiled by the
// API workspace under `moduleResolution: NodeNext`, so its relative imports use
// explicit `.js` specifiers. Metro does not rewrite those back to the `.ts`
// sources it bundles, so resolve them here. Without this the Android bundle
// fails with "Unable to resolve module ./autopilot.js".
const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    const importerDirectory = path.dirname(context.originModulePath);
    for (const extension of [".ts", ".tsx"]) {
      const candidate = path.resolve(
        importerDirectory,
        `${moduleName.slice(0, -".js".length)}${extension}`,
      );
      if (fs.existsSync(candidate)) {
        return { type: "sourceFile", filePath: candidate };
      }
    }
  }
  const resolveRequest = upstreamResolveRequest ?? context.resolveRequest;
  return resolveRequest(context, moduleName, platform);
};

module.exports = config;
