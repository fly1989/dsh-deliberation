import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/mid-fork-provider.ts'],
  format: ['esm'],
  outDir: 'lib',
  fixedExtension: false,
  clean: true,
  dts: true,
  sourcemap: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-subagent',
      '@deepseek-ai/dsh-subagent-in-process-driver',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-timeout',
      '@deepseek-ai/dsh-tools',
    ],
  },
})
