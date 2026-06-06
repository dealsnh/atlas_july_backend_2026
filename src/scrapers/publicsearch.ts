// @ts-nocheck
/**
 * publicsearch.us WebSocket Scraper
 *
 * Reverse-engineered from the @kofile/publicsearch browser client.
 * Protocol: WebSocket with JSON messages (not binary).
 *
 * Auth flow:
 *   1. GET https://{slug}.{state}.publicsearch.us/ → sets authToken cookie
 *   2. Connect WS: wss://{slug}.{state}.publicsearch.us/ws
 *   3. Send @kofile/FETCH_DOCUMENTS/v4 with authToken in payload
 *   4. Receive @kofile/FETCH_DOCUMENTS_FULFILLED/v6 with results
 *
 * Message format (sent):
 * {
 *   "type": "@kofile/FETCH_DOCUMENTS/v4",
 *   "payload": {
 *     "query": {
 *       "limit": "50", "offset": "0",
 *       "department": "RP",
 *       "keywordSearch": false,
 *       "recordedDateRange": "YYYYMMDD,YYYYMMDD",
 *       "searchOcrText": false,
 *       "searchType": "quickSearch",
 *       "searchValue": "LIS PENDENS"
 *     },
 *     "workspaceID": "<random 20-char alphanumeric>"
 *   },
 *   "authToken": "<from cookie>",
 *   "ip": "0.0.0.0",
 *   "correlationId": "<uuid>",
 *   "sync": true
 * }
 */

import { WebSocket } from 'ws';
import { fetchWithRetry } from './base.js';

export interface PublicSearchDoc {
  docId: number;
  instrumentNumber: string;
  docNumber: string;
  docType: string;
  docTypeCode: string;
  recordedDate: string;
  instrumentDate: string;
  grantor: string[];
  grantee: string[];
  legalDescription: string[];
  legals: Array<{
    legalType: string;
    developmentName?: string;
    lot?: string;
    block?: string;
    lglDesc?: string;
    description?: string;
  }>;
  lot: string[];
  block: string[];
  ocrText: string;
  downloadLink: string;
}

function makeWorkspaceId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function makeCorrelationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function formatDateRange(fromDate: string, toDate: string): string {
  // Convert YYYY-MM-DD to YYYYMMDD
  return `${fromDate.replace(/-/g, '')},${toDate.replace(/-/g, '')}`;
}

/**
 * Scrape documents from a publicsearch.us county portal via WebSocket.
 *
 * @param slug       County subdomain (e.g. "nueces", "jimwells", "sanpatricio")
 * @param stateCode  State code (e.g. "tx", "mo", "oh")
 * @param searchValue Search term (e.g. "LIS PENDENS", "PROBATE", "DIVORCE")
 * @param department  Department code (default "RP" for Real Property)
 * @param fromDate   Start date YYYY-MM-DD
 * @param toDate     End date YYYY-MM-DD
 * @param maxDocs    Maximum documents to fetch (default 500)
 */
export async function scrapePublicSearch(
  slug: string,
  stateCode: string,
  searchValue: string,
  fromDate: string,
  toDate: string,
  department = 'RP',
  maxDocs = 500
): Promise<PublicSearchDoc[]> {
  const baseUrl = `https://${slug}.${stateCode}.publicsearch.us`;
  const wsUrl = `wss://${slug}.${stateCode}.publicsearch.us/ws`;
  const allDocs: PublicSearchDoc[] = [];

  // Step 1: GET the page to obtain authToken cookie
  let authToken = '';
  try {
    const res = await fetchWithRetry(baseUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const setCookieHeader = res.headers.get('set-cookie') || '';
    const match = setCookieHeader.match(/authToken=([^;]+)/);
    if (match) {
      authToken = match[1];
    }
    if (!authToken) {
      // Try to extract from response body (some portals embed it)
      const html = await res.text();
      const bodyMatch = html.match(/"authToken"\s*:\s*"([^"]+)"/);
      if (bodyMatch) authToken = bodyMatch[1];
    }
  } catch (e) {
    console.error(`[publicsearch] Failed to get authToken from ${baseUrl}:`, e);
    return [];
  }

  if (!authToken) {
    console.warn(`[publicsearch] No authToken found for ${slug}.${stateCode} — skipping`);
    return [];
  }

  // Step 2: Paginate via WebSocket
  const pageSize = 50;
  let offset = 0;
  let totalFetched = 0;
  let hasMore = true;

  while (hasMore && totalFetched < maxDocs) {
    const docs = await fetchPageViaWS(wsUrl, authToken, {
      department,
      searchValue,
      dateRange: formatDateRange(fromDate, toDate),
      offset: String(offset),
      limit: String(pageSize),
    });

    if (docs.length === 0) break;
    allDocs.push(...docs);
    totalFetched += docs.length;
    offset += pageSize;
    hasMore = docs.length === pageSize;
  }

  return allDocs;
}

interface WSQueryParams {
  department: string;
  searchValue: string;
  dateRange: string;
  offset: string;
  limit: string;
}

function fetchPageViaWS(
  wsUrl: string,
  authToken: string,
  params: WSQueryParams
): Promise<PublicSearchDoc[]> {
  return new Promise((resolve) => {
    const workspaceID = makeWorkspaceId();
    const correlationId = makeCorrelationId();
    const timeout = setTimeout(() => {
      ws.terminate();
      resolve([]);
    }, 30000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          'Cookie': `authToken=${authToken}`,
          'Origin': wsUrl.replace('wss://', 'https://').replace('/ws', ''),
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
      });
    } catch (e) {
      clearTimeout(timeout);
      resolve([]);
      return;
    }

    ws.on('open', () => {
      const msg = {
        type: '@kofile/FETCH_DOCUMENTS/v4',
        payload: {
          query: {
            limit: params.limit,
            offset: params.offset,
            department: params.department,
            keywordSearch: false,
            recordedDateRange: params.dateRange,
            searchOcrText: false,
            searchType: 'quickSearch',
            searchValue: params.searchValue,
          },
          workspaceID,
        },
        authToken,
        ip: '0.0.0.0',
        correlationId,
        sync: true,
      };
      ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data: Buffer | string) => {
      try {
        const str = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(str);
        if (
          msg.type === '@kofile/FETCH_DOCUMENTS_FULFILLED/v6' &&
          msg.correlationId === correlationId
        ) {
          clearTimeout(timeout);
          ws.close();
          const byHash = msg.payload?.data?.byHash || {};
          const byOrder: number[] = msg.payload?.data?.byOrder || [];
          const docs: PublicSearchDoc[] = byOrder
            .map((id: number) => byHash[String(id)])
            .filter(Boolean)
            .map((doc: any) => ({
              docId: doc.docId || doc.id,
              instrumentNumber: doc.instrumentNumber || doc.docNumber || '',
              docNumber: doc.docNumber || doc.instrumentNumber || '',
              docType: (doc.docType || '').replace(/<[^>]+>/g, '').trim(),
              docTypeCode: doc.docTypeCode || '',
              recordedDate: doc.recordedDate || '',
              instrumentDate: doc.instrumentDate || '',
              grantor: Array.isArray(doc.grantor) ? doc.grantor.filter(Boolean) : [],
              grantee: Array.isArray(doc.grantee) ? doc.grantee.filter(Boolean) : [],
              legalDescription: Array.isArray(doc.legalDescription)
                ? doc.legalDescription.filter(Boolean)
                : [],
              legals: Array.isArray(doc.legals) ? doc.legals : [],
              lot: Array.isArray(doc.lot) ? doc.lot.filter(Boolean) : [],
              block: Array.isArray(doc.block) ? doc.block.filter(Boolean) : [],
              ocrText: doc.ocrText || '',
              downloadLink: doc.downloadLink || '',
            }));
          resolve(docs);
        }
      } catch {
        // ignore parse errors
      }
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve([]);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve([]);
    });
  });
}

/**
 * Extract a property address from a publicsearch document's legal descriptions.
 * Returns the first string that looks like a street address.
 */
export function extractAddressFromDoc(doc: PublicSearchDoc): string | null {
  for (const desc of doc.legalDescription) {
    // Match patterns like "123 MAIN ST CORPUS CHRISTI TX 78401"
    if (/^\d+\s+[A-Z]/.test(desc) && desc.length > 10) {
      return desc;
    }
  }
  for (const legal of doc.legals) {
    if (legal.lglDesc && /^\d+\s+[A-Z]/.test(legal.lglDesc)) {
      return legal.lglDesc;
    }
  }
  return null;
}

/**
 * Extract subdivision/lot/block info from a publicsearch document.
 */
export function extractSubdivisionFromDoc(doc: PublicSearchDoc): string | null {
  for (const legal of doc.legals) {
    if (legal.legalType === 'Subdivision' && legal.developmentName) {
      const parts = [`Subdivision: ${legal.developmentName}`];
      if (legal.lot) parts.push(`Lot: ${legal.lot}`);
      if (legal.block) parts.push(`Block: ${legal.block}`);
      return parts.join(', ');
    }
  }
  return null;
}
