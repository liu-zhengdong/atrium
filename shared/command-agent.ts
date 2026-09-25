// A suggested shell command may use a name only if it remains one positional token.
// Leading '-' would be parsed as an option; all other shell punctuation uses the short ref.
export function commandAgent(name: string, ref: string): string {
  return /^[\p{L}\p{N}_.][\p{L}\p{N}_.-]*$/u.test(name) ? name : ref;
}
