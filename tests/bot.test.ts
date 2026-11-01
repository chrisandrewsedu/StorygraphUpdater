import { describe, it, expect } from 'vitest';
import { TELEGRAM_BOT_OPTIONS } from '../src/bot.js';

describe('TELEGRAM_BOT_OPTIONS', () => {
  it('times out HTTP requests a little after the long-poll window', () => {
    // A long-poll whose connection dies silently must not hang forever,
    // or polling stops and button presses are never fetched.
    const pollSeconds = (TELEGRAM_BOT_OPTIONS.polling as { params: { timeout: number } }).params.timeout;
    const requestMs = TELEGRAM_BOT_OPTIONS.request?.timeout;
    expect(requestMs).toBeGreaterThan(pollSeconds * 1000);
    expect(requestMs).toBeLessThanOrEqual(pollSeconds * 1000 + 30_000);
  });
});
