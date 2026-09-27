#!/usr/bin/env node
import { load } from "./entry.mjs";
const { runSupervisor } = await load("supervisor");
await runSupervisor(process.argv.slice(2));
