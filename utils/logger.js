// utils/logger.js — 컬러 콘솔 로거

const COLORS = {
  reset:   '\x1b[0m',
  bright:  '\x1b[1m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function formatPrefix(level, color) {
  return `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${color}${COLORS.bright}[${level}]${COLORS.reset}`;
}

const logger = {
  info(msg, ...args) {
    console.log(`${formatPrefix('INFO', COLORS.cyan)} ${msg}`, ...args);
  },

  success(msg, ...args) {
    console.log(`${formatPrefix('OK  ', COLORS.green)} ${msg}`, ...args);
  },

  warn(msg, ...args) {
    console.warn(`${formatPrefix('WARN', COLORS.yellow)} ${msg}`, ...args);
  },

  error(msg, ...args) {
    console.error(`${formatPrefix('ERR ', COLORS.red)} ${msg}`, ...args);
  },

  event(eventName, socketId, data) {
    console.log(
      `${formatPrefix('EVT ', COLORS.magenta)} ` +
      `${COLORS.bright}${eventName}${COLORS.reset} ` +
      `from ${COLORS.cyan}${socketId}${COLORS.reset}`,
      '\n  data:', JSON.stringify(data, null, 2)
        .split('\n')
        .map((l, i) => (i === 0 ? l : '        ' + l))
        .join('\n')
    );
  },

  connect(socketId, address) {
    console.log(
      `${formatPrefix('CONN', COLORS.green)} ` +
      `socket ${COLORS.bright}${socketId}${COLORS.reset} ` +
      `connected from ${COLORS.cyan}${address}${COLORS.reset}`
    );
  },

  disconnect(socketId, reason) {
    console.log(
      `${formatPrefix('DISC', COLORS.yellow)} ` +
      `socket ${COLORS.bright}${socketId}${COLORS.reset} ` +
      `disconnected — reason: ${COLORS.yellow}${reason}${COLORS.reset}`
    );
  },
};

module.exports = logger;
