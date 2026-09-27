#!/usr/bin/env node
import { load } from "./entry.mjs";
const { main } = await load("cli");
process.exitCode = await main(process.argv.slice(2));
