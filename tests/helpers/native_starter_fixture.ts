import { readFile } from 'node:fs/promises'

/** Reads a stock native starter file from `tests/fixtures/native_starter`. */
export const stock = (path: string) =>
  readFile(new URL(`../fixtures/native_starter/${path}.fixture`, import.meta.url), 'utf8')
