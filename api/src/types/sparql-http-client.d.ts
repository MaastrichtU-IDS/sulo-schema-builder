declare module 'sparql-http-client' {
  interface QueryOptions {
    headers?: HeadersInit;
    defaultGraph?: string[];
    namedGraph?: string[];
    operation?: 'get' | 'postUrlencoded' | 'postDirect';
    parameters?: Record<string, unknown>;
    update?: boolean;
    [key: string]: unknown;
  }

  class RawQuery {
    select(query: string, options?: QueryOptions): Promise<Response>;
    ask(query: string, options?: QueryOptions): Promise<Response>;
    construct(query: string, options?: QueryOptions): Promise<Response>;
    update(query: string, options?: QueryOptions): Promise<Response>;
  }

  export class SimpleClient {
    query: RawQuery;
    constructor(options: { endpointUrl: string; updateUrl?: string; headers?: Record<string, string> });
    get(query: string, options?: QueryOptions): Promise<Response>;
    postUrlencoded(query: string, options?: QueryOptions): Promise<Response>;
    postDirect(query: string, options?: QueryOptions): Promise<Response>;
  }
  export default SimpleClient;
}
