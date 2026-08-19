import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock('./client.js', () => ({
  apiClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: (...args: unknown[]) => patch(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

const backend = await import('./backend.js');

describe('backend dispatch', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
    del.mockReset();
  });

  it('lists schemas over REST without consulting a storage-mode endpoint', async () => {
    get.mockResolvedValue({ data: [{ id: 'a', title: 'A' }] });

    const result = await backend.listSchemas();

    expect(result).toEqual([{ id: 'a', title: 'A' }]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/ontology-schemas');
  });

  it('creates a schema over REST', async () => {
    post.mockResolvedValue({ data: { id: 'b', title: 'B' } });

    const result = await backend.createSchema({ title: 'B' });

    expect(result).toEqual({ id: 'b', title: 'B' });
    expect(post).toHaveBeenCalledWith('/ontology-schemas', { title: 'B' });
  });

  it('fetches upper concepts through the per-schema route', async () => {
    get.mockResolvedValue({ data: [] });

    await backend.fetchUpperConcepts('sid');

    expect(get).toHaveBeenCalledWith('/ontology-schemas/sid/upper-concepts');
  });
});
