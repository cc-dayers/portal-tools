#!/usr/bin/env node

import { run } from './cli.mjs';

process.exitCode = await run();
