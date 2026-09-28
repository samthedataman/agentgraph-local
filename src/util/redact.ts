// Credential formats that show up pasted into prompts and tool output.
// `apikey\_…` covers keys whose underscores a chat client markdown-escaped.
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16}|apikey\\?_[A-Za-z0-9](?:[A-Za-z0-9]|\\?_){19,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

export function redactSecrets(value: string): string {
  return value.replaceAll(SECRET_VALUE, "[REDACTED]");
}
