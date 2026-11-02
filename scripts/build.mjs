import { build } from 'esbuild';

for (const [entry, output] of [['worker.js', 'dist/worker.js'], ['zt/worker.js', 'dist/zt-worker.js']]) {
  await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', target: 'es2022', platform: 'browser', sourcemap: false });
  console.log('Built ' + output);
}
