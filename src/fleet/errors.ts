export class FleetValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Fleet plan is invalid:\n- ${issues.join("\n- ")}`);
    this.name = "FleetValidationError";
    this.issues = issues;
  }
}

export class FleetSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetSafetyError";
  }
}
