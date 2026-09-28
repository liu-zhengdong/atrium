import { Problem } from "../../problem.ts";

export class BudgetProblem extends Problem {
  constructor(message: string) {
    super(409, message, "conflict", undefined, "atrium org tree");
  }
}
