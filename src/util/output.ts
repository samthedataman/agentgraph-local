export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeLine(value = ""): void {
  process.stdout.write(`${value}\n`);
}

export function writeError(value: string): void {
  process.stderr.write(`${value}\n`);
}
