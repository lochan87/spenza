import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleVercelRepayment } from '../functions/src/vercelRepayment.ts'

/**
 * Vercel Serverless Function entry point for Spenza Repayment API (/api/repayment).
 * Runtime: Node.js
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleVercelRepayment(req, res)
}

