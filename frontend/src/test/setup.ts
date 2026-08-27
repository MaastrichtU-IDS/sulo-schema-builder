import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship the Compression Streams API (used by the share-link
// codec); borrow Node's implementation, which is spec-compatible.
import { CompressionStream as NodeCS, DecompressionStream as NodeDS } from 'node:stream/web';

if (typeof globalThis.CompressionStream === 'undefined') {
  globalThis.CompressionStream = NodeCS as unknown as typeof globalThis.CompressionStream;
}
if (typeof globalThis.DecompressionStream === 'undefined') {
  globalThis.DecompressionStream = NodeDS as unknown as typeof globalThis.DecompressionStream;
}
