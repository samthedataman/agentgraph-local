export function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

export function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

export function splitPassthrough(args: string[]): [string[], string[]] {
  const index = args.indexOf("--");
  if (index === -1) return [args, []];
  return [args.slice(0, index), args.slice(index + 1)];
}
