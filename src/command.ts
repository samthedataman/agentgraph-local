export interface CommandContext {
  args: string[];
  json: boolean;
}

export type CommandHandler = (context: CommandContext) => Promise<number>;
