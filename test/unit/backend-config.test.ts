import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('backend configuration', () => {
  it('keeps X11 as the default with the existing execution policy', () => {
    const { config } = loadConfig({});
    expect(config.backend).toBe('x11');
    expect(config.exec).toBe(true);
  });

  it('opts into native macOS with its own token and host execution disabled', () => {
    const { config } = loadConfig({}, ['--backend', 'macos']);
    expect(config.backend).toBe('macos');
    expect(config.exec).toBe(false);
    expect(config.tokenFile).toBe(join(homedir(), '.config', 'ozwell-computer', 'macos', 'token'));
    const empty = loadConfig({ OZWELL_COMPUTER_EXEC: '', OZWELL_COMPUTER_TOKEN_FILE: '' }, ['--backend', 'macos']).config;
    expect(empty.exec).toBe(false);
    expect(empty.tokenFile).toBe(config.tokenFile);
    expect(loadConfig({ OZWELL_COMPUTER_SPAWN_XVFB: 'false' }, ['--backend', 'macos']).config.spawnXvfb).toBe(false);
    const repeated = loadConfig({}, ['--backend', 'x11', '--backend', 'macos']).config;
    expect(repeated.exec).toBe(false);
    expect(repeated.tokenFile).toBe(config.tokenFile);
  });

  it('requires explicit opt-in to host execution and preserves explicit token files', () => {
    expect(loadConfig({ OZWELL_COMPUTER_BACKEND: 'macos' }, ['--exec']).config.exec).toBe(true);
    const { config } = loadConfig({ OZWELL_COMPUTER_BACKEND: 'macos', OZWELL_COMPUTER_EXEC: 'true', OZWELL_COMPUTER_TOKEN_FILE: '/tmp/native-token' });
    expect(config.exec).toBe(true);
    expect(config.tokenFile).toBe('/tmp/native-token');
    expect(loadConfig({ OZWELL_COMPUTER_BACKEND: 'macos', OZWELL_COMPUTER_EXEC: 'true' }, ['--no-exec']).config.exec).toBe(false);
  });

  it('rejects X11-only options rather than starting a different desktop', () => {
    expect(() => loadConfig({}, ['--backend', 'macos', '--spawn-xvfb'])).toThrow('only supported');
    expect(() => loadConfig({}, ['--backend', 'macos', '--vnc-backend', 'external:5900'])).toThrow('only supported');
    expect(() => loadConfig({}, ['--backend', 'unknown'])).toThrow();
  });
});
