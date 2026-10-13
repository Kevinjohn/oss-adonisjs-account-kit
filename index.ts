import { fileURLToPath } from 'node:url'

/*
|--------------------------------------------------------------------------
| Package entrypoint
|--------------------------------------------------------------------------
|
| Export values from the package entrypoint as you see fit.
|
*/

export { configure } from './configure.ts'
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))
export * from './src/types.ts'
export * from './src/errors.ts'
export { AccountKit, defineConfig } from './src/account_kit.ts'
