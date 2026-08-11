// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    dim: '\x1b[2m',
};

const c = {
    info: (text: unknown) => `${colors.cyan}${text}${colors.reset}`,
    ok: (text: unknown) => `${colors.green}${text}${colors.reset}`,
    warn: (text: unknown) => `${colors.yellow}${text}${colors.reset}`,
    tip: (text: unknown) => `${colors.blue}${text}${colors.reset}`,
    bright: (text: unknown) => `${colors.bright}${text}${colors.reset}`,
    dim: (text: unknown) => `${colors.dim}${text}${colors.reset}`,
};

export { colors, c };
