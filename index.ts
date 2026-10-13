import { fileURLToPath } from 'node:url'

export { configure } from './configure.ts'
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))
export * from './src/types.ts'
export * from './src/errors.ts'
export { AccountKit, defineConfig } from './src/account_kit.ts'
