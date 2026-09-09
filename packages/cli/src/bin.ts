#!/usr/bin/env node
import { EXIT_CODES } from './index.js';

// Placeholder entry point. The real commands (audit, optimize, check, undo, init)
// are implemented in Phase 3; this keeps `bin` wired and buildable meanwhile.
process.stdout.write('upfly: not implemented yet — see notes/05-build-plan.md\n');
process.exit(EXIT_CODES.OK);
