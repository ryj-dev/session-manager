/** Entry point for `node --import`: installs the .ts resolution hook. */
import { register } from 'node:module'

register('./ts-resolve-hook.mjs', import.meta.url)
