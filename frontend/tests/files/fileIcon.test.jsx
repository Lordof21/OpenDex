// FileIcon: a grid tile's thumbnail is requested for the FILE, not for the folder it is listed in.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../../src/files/thumbCache.js', () => ({ requestThumb: vi.fn(() => Promise.resolve(null)) }));

import { requestThumb } from '../../src/files/thumbCache.js';
import FileIcon from '../../src/files/FileIcon.jsx';

const FOLDER = { provider: 'phone', path: '/storage/emulated/0/DCIM/Camera', device: 'S' };
const photo = { name: 'IMG_0001.jpg', kind: 'file', size: 2_000_000, mtime: 1_700_000_000 };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FileIcon thumbnails', () => {
  it('asks for the file itself, not for the folder it is listed in', () => {
    render(<FileIcon entry={photo} loc={FOLDER} size={84} thumb px={192} />);
    expect(requestThumb).toHaveBeenCalledTimes(1);
    const [loc, px] = requestThumb.mock.calls[0];
    expect(loc).toEqual({ provider: 'phone', path: '/storage/emulated/0/DCIM/Camera/IMG_0001.jpg', device: 'S' });
    expect(px).toBe(192);
  });

  it('uses the location a search result carries with it', () => {
    const own = { provider: 'phone', path: '/storage/emulated/0/Pictures/found.jpg', device: 'S' };
    render(<FileIcon entry={{ ...photo, name: 'found.jpg', _loc: own }} loc={FOLDER} size={84} thumb px={192} />);
    expect(requestThumb.mock.calls[0][0]).toEqual(own);
  });

  it('does not ask for a thumbnail of a folder or when thumbnails are off', () => {
    render(<FileIcon entry={{ name: 'DCIM', kind: 'dir', size: 0, mtime: 0 }} loc={FOLDER} size={84} thumb />);
    render(<FileIcon entry={photo} loc={FOLDER} size={20} />);
    expect(requestThumb).not.toHaveBeenCalled();
  });
});
