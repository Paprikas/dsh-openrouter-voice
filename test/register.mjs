/** Register the CSS shim before the test graph is evaluated. */
import { register } from 'node:module'

register('./css-hook.mjs', import.meta.url)
