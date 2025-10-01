import type { LoaderFunctionArgs } from "react-router";
import { logger } from "~/lib/logger.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context?.cloudflare?.env as { AUTH_DB: D1Database };
  const ctx = context?.cloudflare?.ctx as ExecutionContext;
  
  // Initialize D1 logging
  logger.setDatabase(env?.AUTH_DB || null, true);
  if (ctx) logger.setContext(ctx);
  
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const level = url.searchParams.get('level') || null;
    const service = url.searchParams.get('service') || null;
    
    let query = 'SELECT * FROM logs';
    const params: any[] = [];
    const conditions: string[] = [];
    
    if (level) {
      conditions.push('level = ?');
      params.push(level.toUpperCase());
    }
    
    if (service) {
      conditions.push('service = ?');
      params.push(service.toUpperCase());
    }
    
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    
    const result = await env.AUTH_DB.prepare(query).bind(...params).all();
    
    return new Response(JSON.stringify(result.results, null, 2), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    logger.error('Failed to fetch logs', { 
      error: error instanceof Error ? error.message : String(error) 
    });
    
    return new Response(JSON.stringify({ 
      error: 'Failed to fetch logs',
      message: error instanceof Error ? error.message : String(error)
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
