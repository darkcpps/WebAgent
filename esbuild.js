const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

async function main() {
  const shared = {
    bundle: true,
    sourcemap: true,
    minify: false,
    legalComments: 'none',
    logLevel: 'info',
  };

  const extension = {
    ...shared,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode', 'playwright'],
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
  };

  const webview = {
    ...shared,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    entryPoints: ['src/webview/index.tsx'],
    outfile: 'dist/webview.js',
    loader: {
      '.css': 'css',
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
    },
  };

  if (watch) {
    const ctx1 = await esbuild.context(extension);
    const ctx2 = await esbuild.context(webview);
    await ctx1.watch();
    await ctx2.watch();
    console.log('Watching extension and webview builds...');
    return;
  }

  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
