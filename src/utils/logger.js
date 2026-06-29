const winston = require('winston');
const { combine, timestamp, label, printf } = winston.format;

module.exports = function (spaceName) {
  return winston.createLogger({
    level: 'info',
    format: combine(
      timestamp(),
      label({ label: spaceName }),
      printf(({ timestamp, label, level, message }) => {
        return `${timestamp} [${label}] [${level.toUpperCase().padEnd(5, ' ')}] ${message}`;
      })
    ),
    transports: [
      new winston.transports.Console()
      // - Write all logs with importance level of `error` or higher to `error.log`
      // new winston.transports.File({ filename: 'news.log', level: 'error' }),
      // new winston.transports.File({ filename: 'combined.log' }),
    ],
  })
};