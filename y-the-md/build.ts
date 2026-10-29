/**
 * Compile y-the-md into one self-contained executable.
 *
 *   bun build.ts <outfile>
 *
 * `bun build --compile` alone produces a binary that fails on the first Music
 * Together join: node-datachannel loads its N-API addon through
 * `createRequire(import.meta.url)`, which the bundler cannot see, so the
 * `.node` file is left out and resolved at runtime against a path that only
 * exists inside node_modules.
 *
 * The plugin below rewrites that one load into a plain `require` of the
 * addon's absolute path, which the bundler *does* follow and embeds. The
 * result links only against glibc.
 */
import path from 'node:path';

const outfile = process.argv[2];
if (!outfile) {
  console.error('usage: bun build.ts <outfile>');
  process.exit(2);
}

const root = import.meta.dir;
const addon = path.join(root, 'node_modules/node-datachannel/build/Release/node_datachannel.node');

if (!(await Bun.file(addon).exists())) {
  console.error(`missing ${addon} -- run \`cd mt-peer && bun install\` first (y-the-md/node_modules links there)`);
  process.exit(1);
}

const embedAddon: Bun.BunPlugin = {
  name: 'embed-node-datachannel',
  setup(build) {
    build.onLoad(
      { filter: /node-datachannel[\\/]dist[\\/]esm[\\/]lib[\\/]node-datachannel\.mjs$/ },
      async (args) => {
        const src = await Bun.file(args.path).text();
        const out = src
          .replace(/const require = cjsModule\.createRequire\(import\.meta\.url\);/, '')
          .replace(/require\("[^"]*node_datachannel\.node"\)/, `require(${JSON.stringify(addon)})`);
        // Fail the build rather than ship a binary that breaks at join time.
        if (out === src || !out.includes(addon)) {
          throw new Error(
            'node-datachannel changed how it loads its addon; update the rewrite in y-the-md/build.ts',
          );
        }
        return { contents: out, loader: 'js' };
      },
    );
  },
};

const result = await Bun.build({
  entrypoints: [path.join(root, 'src/main.ts')],
  target: 'bun',
  compile: { outfile },
  plugins: [embedAddon],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
