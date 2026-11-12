import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleVercelImport } from '../functions/src/vercelImport.ts'

/**
 * Vercel Serverless Function entry point for Spenza Spreadsheet Import API (/api/import).
 * Runtime: Node.js
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleVercelImport(req, res)
}
