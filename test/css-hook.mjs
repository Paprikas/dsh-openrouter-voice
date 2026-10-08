/**
 * Node loader shim for the browser half.
 *
 * The built DSH client bundles inline their CSS; the published packages still
 * import `*.module.css` files, which Node cannot parse. This hook maps those
 * specifiers onto an empty module so the real primitives can be exercised.
 */
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export%20default%20%7B%7D', shortCircuit: true }
  }
  return await next(specifier, context)
}
