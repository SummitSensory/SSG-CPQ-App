import { mondayQuery } from './client.js';

/**
 * Board discovery.
 *
 * monday column ids are per-board and opaque ("text8", "email_1", "status_14"),
 * so any import mapping has to be written against the real board rather than
 * assumed. These read-only queries expose what a board actually contains so the
 * mapping can be derived from fact, then frozen in importMapping.ts.
 */

export interface MondayBoardSummary {
  id: string;
  name: string;
  itemsCount: number | null;
}

export interface MondayColumn {
  id: string;
  title: string;
  type: string;
  /** JSON blob: status labels, dropdown options, etc. Shape varies by type. */
  settingsStr: string | null;
}

export interface MondayItemSample {
  id: string;
  name: string;
  columns: Array<{ id: string; title: string; type: string; text: string | null; value: string | null }>;
}

export interface MondayBoardDetail {
  id: string;
  name: string;
  columns: MondayColumn[];
  sample: MondayItemSample[];
}

/** Every board the API token can see. */
export async function listBoards(limit = 100): Promise<MondayBoardSummary[]> {
  const data = await mondayQuery<{
    boards: Array<{ id: string; name: string; items_count: number | null }>;
  }>(
    `query ($limit: Int!) {
       boards (limit: $limit, order_by: used_at) { id name items_count }
     }`,
    { limit },
  );
  return data.boards.map((b) => ({ id: b.id, name: b.name, itemsCount: b.items_count ?? null }));
}

/**
 * A board's columns plus a few real items, so a mapping can be written against
 * actual values (and so we can see which columns are consistently populated).
 */
export async function describeBoard(boardId: string, sampleSize = 3): Promise<MondayBoardDetail> {
  const data = await mondayQuery<{
    boards: Array<{
      id: string;
      name: string;
      columns: Array<{ id: string; title: string; type: string; settings_str: string | null }>;
      items_page: {
        items: Array<{
          id: string;
          name: string;
          column_values: Array<{
            id: string;
            text: string | null;
            value: string | null;
            column: { title: string; type: string };
          }>;
        }>;
      };
    }>;
  }>(
    `query ($board: [ID!], $limit: Int!) {
       boards (ids: $board) {
         id
         name
         columns { id title type settings_str }
         items_page (limit: $limit) {
           items {
             id
             name
             column_values { id text value column { title type } }
           }
         }
       }
     }`,
    { board: [boardId], limit: sampleSize },
  );

  const board = data.boards[0];
  if (!board) throw new Error(`monday board ${boardId} not found or not visible to this token`);

  return {
    id: board.id,
    name: board.name,
    columns: board.columns.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      settingsStr: c.settings_str ?? null,
    })),
    sample: board.items_page.items.map((i) => ({
      id: i.id,
      name: i.name,
      columns: i.column_values.map((cv) => ({
        id: cv.id,
        title: cv.column.title,
        type: cv.column.type,
        text: cv.text,
        value: cv.value,
      })),
    })),
  };
}

export interface MondayItem {
  id: string;
  name: string;
  /** column id -> display text */
  text: Record<string, string>;
  /** column id -> raw JSON value (needed for email/phone/location columns) */
  raw: Record<string, string | null>;
}

const ITEM_FIELDS = `
  id
  name
  column_values {
    id
    text
    value
    ... on MirrorValue { display_value }
    ... on FormulaValue { display_value }
    ... on BoardRelationValue { display_value }
  }
`;

function toItem(item: {
  id: string;
  name: string;
  column_values: Array<{ id: string; text: string | null; value: string | null; display_value?: string | null }>;
}): MondayItem {
  const text: Record<string, string> = {};
  const raw: Record<string, string | null> = {};
  for (const cv of item.column_values) {
    text[cv.id] = cv.text || cv.display_value || '';
    raw[cv.id] = cv.value;
  }
  return { id: item.id, name: item.name, text, raw };
}

/**
 * Items whose NAME contains a term. This is how a single customer is pulled on
 * demand at proposal time — one query, no board walk.
 */
export async function searchItemsByName(
  boardId: string,
  term: string,
  limit = 25,
): Promise<MondayItem[]> {
  const data = await mondayQuery<{
    boards: Array<{ items_page: { items: Array<Parameters<typeof toItem>[0]> } }>;
  }>(
    `query ($board: [ID!], $limit: Int!, $term: CompareValue!) {
       boards (ids: $board) {
         items_page (
           limit: $limit,
           query_params: { rules: [{ column_id: "name", compare_value: $term, operator: contains_text }] }
         ) { items { ${ITEM_FIELDS} } }
       }
     }`,
    { board: [boardId], limit, term: [term] },
  );
  return (data.boards[0]?.items_page.items ?? []).map(toItem);
}

/** A single item by id, with the raw column payload kept for inspection. */
export async function fetchItemById(itemId: string): Promise<MondayItem | null> {
  const data = await mondayQuery<{ items: Array<Parameters<typeof toItem>[0]> }>(
    `query ($ids: [ID!]) { items (ids: $ids) { ${ITEM_FIELDS} } }`,
    { ids: [itemId] },
  );
  const item = data.items?.[0];
  return item ? toItem(item) : null;
}

/**
 * Every item on a board, following the cursor. monday caps page size at 500;
 * the client already backs off on rate limits and complexity errors.
 */
export async function fetchAllItems(
  boardId: string,
  pageSize = 250,
  /** Stop paging once this many items are in hand — keeps a limited run inside
   *  the serverless function timeout instead of downloading the whole board. */
  max?: number,
): Promise<MondayItem[]> {
  const out: MondayItem[] = [];
  let cursor: string | null = null;
  const pageLimit = max ? Math.min(pageSize, max) : pageSize;

  do {
    const data: {
      boards: Array<{
        items_page: {
          cursor: string | null;
          items: Array<{
            id: string;
            name: string;
            column_values: Array<{
              id: string;
              text: string | null;
              value: string | null;
              /** mirror / formula / board_relation columns expose their rendered
               *  value here; their `text` is always null. */
              display_value?: string | null;
            }>;
          }>;
        };
      }>;
    } = await mondayQuery(
      `query ($board: [ID!], $limit: Int!, $cursor: String) {
         boards (ids: $board) {
           items_page (limit: $limit, cursor: $cursor) {
             cursor
             items {
               id
               name
               column_values {
                 id
                 text
                 value
                 ... on MirrorValue { display_value }
                 ... on FormulaValue { display_value }
                 ... on BoardRelationValue { display_value }
               }
             }
           }
         }
       }`,
      { board: [boardId], limit: pageLimit, cursor },
    );

    const page = data.boards[0]?.items_page;
    if (!page) break;

    for (const item of page.items) {
      const text: Record<string, string> = {};
      const raw: Record<string, string | null> = {};
      for (const cv of item.column_values) {
        text[cv.id] = cv.text || cv.display_value || '';
        raw[cv.id] = cv.value;
      }
      out.push({ id: item.id, name: item.name, text, raw });
    }
    if (max && out.length >= max) return out.slice(0, max);
    cursor = page.cursor;
  } while (cursor);

  return out;
}
