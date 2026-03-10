// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

/**
 * Get formatted timestamp string
 * @returns {string}
 */
function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Log an info message with prefix
 * @param {string} prefix - Log prefix (e.g., 'PROXY', 'SERVER')
 * @param {string} message - Log message
 */
export function log(prefix, message) {
  console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.cyan}[${prefix}]${COLORS.reset} ${message}`);
}

/**
 * Log an error message with prefix
 * @param {string} prefix - Log prefix
 * @param {string} message - Error message
 */
export function logError(prefix, message) {
  console.error(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red}[${prefix}]${COLORS.reset} ${COLORS.red}${message}${COLORS.reset}`);
}

/**
 * Log a warning message with prefix
 * @param {string} prefix - Log prefix
 * @param {string} message - Warning message
 */
export function logWarn(prefix, message) {
  console.warn(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}[${prefix}]${COLORS.reset} ${COLORS.yellow}${message}${COLORS.reset}`);
}

/**
 * Log a success message with prefix
 * @param {string} prefix - Log prefix
 * @param {string} message - Success message
 */
export function logSuccess(prefix, message) {
  console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}[${prefix}]${COLORS.reset} ${COLORS.green}${message}${COLORS.reset}`);
}

/**
 * Simple log without timestamp (for startup banners etc.)
 * @param {string} message
 */
export function logRaw(message) {
  console.log(message);
}
