import { defineConfig } from 'vite';
import { resolve } from 'path';

const label = 'performance-helpers';

export default defineConfig({
  base: './',
  worker: { format: 'es', inline: true },
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.js'),
      name: 'PerformanceHelpers',
      formats: ['es', 'cjs', 'umd'],
      fileName: (format) => {
        // Keep the UMD name as `performance-helpers.js`: it is the name the
        // README and the umd.bundle.* tests use. Previously `cjs` produced
        // `performance-helpers.cjs.js` (a doubled extension).
        if (format === 'umd') return `${label}.js`;
        if (format === 'cjs') return `${label}.cjs`;
        return `${label}.${format}.js`;
      },
    },
    assetsInlineLimit: 0,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
      format: {
        comments: false,
      },
    },
  },
});
