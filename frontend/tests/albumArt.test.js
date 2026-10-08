// Album art is app-supplied data from the phone: only inline image data, our blobs or our own backend become <img src>.
import { describe, expect, it } from 'vitest';
import { getAlbumArtUrl } from '../src/lib/utils.js';

describe('getAlbumArtUrl', () => {
  it('accepts inline image data, blobs and the backend', () => {
    expect(getAlbumArtUrl('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(getAlbumArtUrl('blob:http://127.0.0.1:8710/abc')).toBe('blob:http://127.0.0.1:8710/abc');
    expect(getAlbumArtUrl('http://127.0.0.1:8710/api/media/art/1')).toBe('http://127.0.0.1:8710/api/media/art/1');
    expect(getAlbumArtUrl('/9j/4AAQSkZJRg' + 'A'.repeat(60))).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('refuses remote URLs and non-image data URIs', () => {
    expect(getAlbumArtUrl('https://tracker.example/pixel.gif')).toBeNull();
    expect(getAlbumArtUrl('http://127.0.0.1:8710.evil.example/x')).toBeNull();
    expect(getAlbumArtUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(getAlbumArtUrl(null)).toBeNull();
  });
});
