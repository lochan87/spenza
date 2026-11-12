import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleVercelSettlement } from '../functions/src/vercelSettlement.ts'

/**
 * Vercel Serverless Function entry point for Spenza Settlement API (/api/settlement).
 * Runtime: Node.js
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleVercelSettlement(req, res)
}
