#!/usr/bin/env node
import { runDoctor } from "./server/doctor.js";
import { startHttpServer } from "./server/http.js";
import { startMcpServer } from "./server/mcp.js";

if (process.argv[2] === "mcp") await startMcpServer();
else if (process.argv[2] === "doctor") await runDoctor();
else startHttpServer();
