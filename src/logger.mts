import { createLogger, format, transports } from 'winston';
import { DateTime } from 'luxon';
import { env } from './env.mts';

const { combine, printf, errors } = format;

// Custom levels matching the LOG_LEVEL env enum. Winston's default npm levels
// lack `trace` and `fatal`, so we declare them explicitly (pino-style ordering).
const levels = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const;

type LogLevel = keyof typeof levels;
type LogMeta = Record<string, unknown>;

// Custom formatter — matches the structured log style used across the agent.
// Output: <ISO timestamp> [LEVEL] <message>  { ...meta }
const lineFormat = printf(({ level, message, timestamp, ...meta }) => {
  const ts = timestamp as string;
  const metaStr = Object.keys(meta).length > 0 ? `  ${JSON.stringify(meta)}` : '';
  return `${ts} [${level.toUpperCase()}] ${String(message)}${metaStr}`;
});

const timestampFormat = format((info) => {
  info['timestamp'] = DateTime.utc().toISO();
  return info;
});

const winstonLogger = createLogger({
  levels,
  level: env.LOG_LEVEL,
  format: combine(
    errors({ stack: true }),
    timestampFormat(),
    lineFormat,
  ),
  transports: [
    new transports.File({
      filename: env.LOG_FILE,
      options: { flags: 'a' },
    }),
  ],
});

// Pino-style facade over Winston. Each method accepts either a bare message or
// a metadata object followed by a message — the call convention used across the
// codebase — and translates to Winston's (message, meta) signature.
interface AppLogger {
  fatal(obj: LogMeta, msg: string): void;
  fatal(msg: string): void;
  error(obj: LogMeta, msg: string): void;
  error(msg: string): void;
  warn(obj: LogMeta, msg: string): void;
  warn(msg: string): void;
  info(obj: LogMeta, msg: string): void;
  info(msg: string): void;
  debug(obj: LogMeta, msg: string): void;
  debug(msg: string): void;
  trace(obj: LogMeta, msg: string): void;
  trace(msg: string): void;
}

function emit(level: LogLevel, objOrMsg: LogMeta | string, msg?: string): void {
  if (typeof objOrMsg === 'string') {
    winstonLogger.log(level, objOrMsg);
    return;
  }
  winstonLogger.log(level, msg ?? '', objOrMsg);
}

export const logger: AppLogger = {
  fatal: (objOrMsg: LogMeta | string, msg?: string): void => emit('fatal', objOrMsg, msg),
  error: (objOrMsg: LogMeta | string, msg?: string): void => emit('error', objOrMsg, msg),
  warn: (objOrMsg: LogMeta | string, msg?: string): void => emit('warn', objOrMsg, msg),
  info: (objOrMsg: LogMeta | string, msg?: string): void => emit('info', objOrMsg, msg),
  debug: (objOrMsg: LogMeta | string, msg?: string): void => emit('debug', objOrMsg, msg),
  trace: (objOrMsg: LogMeta | string, msg?: string): void => emit('trace', objOrMsg, msg),
};

export type Logger = typeof logger;
