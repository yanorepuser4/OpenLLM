
/**Get environment variable given the key
 * @param {string} key
 * @return {string|undefined} value
 * */
export function readEnv(key) {
  if (typeof process !== 'undefined') {
    return process.env?.[key] ?? undefined;
  }
  if (typeof Deno !== 'undefined') {
    return Deno.env.get(key);
  }
  return undefined;
}
