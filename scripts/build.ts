import { build } from "esbuild";
import type { BuildOptions } from "esbuild";

// One self-contained file for GitHub's node24 runtime (actions can't run pnpm install).
export const options: BuildOptions = {
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/index.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "none",
  // Some bundled CommonJS (yaml) calls require(); give the ES module one.
  banner: {
    js: '// Built by packages/action/scripts/build.ts. Do not edit.\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
  },
};

if (import.meta.url === `file://${process.argv[1]}`) await build(options);
