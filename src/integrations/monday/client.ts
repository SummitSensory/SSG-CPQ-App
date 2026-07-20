import { env } from '../../config/env.js';

const API_URL = 'https://api.monday.com/v2';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** Thin monday.com GraphQL v2 client. Token comes only from env, never source. */
export async function mondayQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN not configured');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: env.MONDAY_API_TOKEN,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`monday API HTTP ${res.status}`);
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) throw new Error('monday API error: ' + body.errors.map((e) => e.message).join('; '));
  if (!body.data) throw new Error('monday API returned no data');
  return body.data;
}

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
