import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

import { createClipboardWriter } from './clipboard.js';

function fakeChild(exitCode: number | null) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable & { endedWith?: string };
  };
  const written: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      written.push(chunk.toString());
      cb();
    },
  }) as Writable & { endedWith?: string };
  stdin.on('finish', () => {
    stdin.endedWith = written.join('');
  });
  child.stdin = stdin;
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

describe('createClipboardWriter', () => {
  it('spawns pbcopy on darwin and writes text to its stdin', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    const write = createClipboardWriter({
      platform: 'darwin',
      spawnFn: spawnFn as never,
    });
    await write('hello clipboard');
    expect(spawnFn).toHaveBeenCalledWith('pbcopy', [], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
  });

  it('spawns clip on win32', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    const write = createClipboardWriter({
      platform: 'win32',
      spawnFn: spawnFn as never,
    });
    await write('hi');
    expect(spawnFn).toHaveBeenCalledWith('clip', [], expect.anything());
  });

  it('spawns xclip -selection clipboard on linux', async () => {
    const spawnFn = vi.fn(() => fakeChild(0));
    const write = createClipboardWriter({
      platform: 'linux',
      spawnFn: spawnFn as never,
    });
    await write('hi');
    expect(spawnFn).toHaveBeenCalledWith(
      'xclip',
      ['-selection', 'clipboard'],
      expect.anything(),
    );
  });

  it('rejects when the clipboard command exits non-zero', async () => {
    const spawnFn = vi.fn(() => fakeChild(1));
    const write = createClipboardWriter({
      platform: 'darwin',
      spawnFn: spawnFn as never,
    });
    await expect(write('hi')).rejects.toThrow('pbcopy exited with code 1');
  });

  it('rejects when spawn itself throws', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const write = createClipboardWriter({
      platform: 'darwin',
      spawnFn: spawnFn as never,
    });
    await expect(write('hi')).rejects.toThrow('ENOENT');
  });

  it('rejects when the spawned child emits an error event', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdin: Writable };
      child.stdin = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      setImmediate(() => child.emit('error', new Error('spawn failed')));
      return child;
    });
    const write = createClipboardWriter({
      platform: 'darwin',
      spawnFn: spawnFn as never,
    });
    await expect(write('hi')).rejects.toThrow('spawn failed');
  });
});
