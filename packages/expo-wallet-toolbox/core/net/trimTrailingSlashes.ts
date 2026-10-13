/**
 * `s` without its trailing slashes ("https://host//" → "https://host").
 *
 * In place of `s.replace(/\/+$/, '')`: on a string with many slashes that
 * aren't at its end, that regex backtracks from every one of them, quadratic
 * in the input (CodeQL js/polynomial-redos). URLs reach these call sites
 * from links, QR codes and other apps.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return end === s.length ? s : s.slice(0, end)
}
