#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();
const { runSupervisor } = await import("../server/supervisor.ts");
await runSupervisor(process.argv.slice(2));
