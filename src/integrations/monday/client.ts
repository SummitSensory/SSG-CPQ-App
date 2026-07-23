import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const API_URL = 'https://api.monday.com/v2';
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  error_code?: string;
  status_code?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, MAX_BACKOFF_MS);
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return exp + Math.floor(Math.random() * 250); // jitter
}

/**
 * monday.com GraphQL v2 client with rate-limit handling. Retries on HTTP 429
 * (honoring Retry-After) and on monday complexity/limit error codes, with
 * capped exponential backoff. Token comes only from env.
 */
export async function mondayQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  if (!env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN not configured');

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: env.MONDAY_API_TOKEN, 'API-Version': '2024-01' },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '') || undefined;
      const wait = backoff(attempt, retryAfter);
      logger.warn({ attempt, wait }, 'monday 429 rate-limited; backing off');
      await sleep(wait);
      lastErr = new Error('monday API HTTP 429');
      continue;
    }
    if (!res.ok) throw new Error(`monday API HTTP ${res.status}`);

    const body = (await res.json()) as GraphQLResponse<T>;
    const code = body.error_code ?? body.errors?.[0]?.extensions?.code;
    if (code === 'ComplexityException' || code === 'RATE_LIMIT_EXCEEDED') {
      const wait = backoff(attempt);
      logger.warn({ attempt, code, wait }, 'monday complexity/rate limit; backing off');
      await sleep(wait);
      lastErr = new Error(`monday ${code}`);
      continue;
    }
    if (body.errors?.length) throw new Error('monday API error: ' + body.errors.map((e) => e.message).join('; '));
    if (!body.data) throw new Error('monday API returned no data');
    return body.data;
  }
  throw lastErr ?? new Error('monday API: exhausted retries');
}

export { backoff };

export async function createItem(boardId: string, name: string, columnValues: Record<string, unknown>): Promise<string> {
  const data = await mondayQuery<{ create_item: { id: string } }>(
    `mutation ($board: ID!, $name: String!, $cols: JSON!) {
       create_item (board_id: $board, item_name: $name, column_values: $cols) { id }
     }`,
    { board: boardId, name, cols: JSON.stringify(columnValues) },
  );
  return data.create_item.id;
}

export async function updateItem(boardId: string, itemId: string, name: string, columnValues: Record<string, unknown>): Promise<void> {
  await mondayQuery(
    `mutation ($board: ID!, $item: ID!, $cols: JSON!) {
       change_multiple_column_values (board_id: $board, item_id: $item, column_values: $cols) { id }
     }`,
    { board: boardId, item: itemId, cols: JSON.stringify({ name, ...columnValues }) },
  );
}
