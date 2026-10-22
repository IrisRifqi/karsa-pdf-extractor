#!/usr/bin/env node
'use strict';
/**
 * pdf_server.js -- tiny HTTP wrapper around pdf_table.js.
 *
 * Node port of tools/pdf_server.py. Same contract, same port, so an n8n workflow
 * pointed at /extract does not care which implementation answers:
 *
 *   POST /extract   body = raw PDF bytes (or {"pdfBase64":"..."})  -> 200 + {"kolam":[...],"rows":[...]}
 *   GET  /health                                                    -> 200 + {"ok":true}
 *
 * Auth: optional. When EXTRACTOR_TOKEN is set, /extract requires a matching
 * `X-Auth` header. Off by default, which keeps parity with the Python service.
 */

const http = require('http');
const { extract } = require('./pdf_table');

const PORT = parseInt(process.env.PORT || '8765', 10);
const MAX_BYTES = parseInt(process.env.MAX_BYTES || String(40 * 1024 * 1024), 10);
const TOKEN = process.env.EXTRACTOR_TOKEN || '';
const SERVER_VERSION = 'pdf-table/2.0';

function send(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const path = String(req.url || '').split('?')[0];

  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (path !== '/extract' || req.method !== 'POST') return send(res, 404, { error: 'not found' });

  if (TOKEN && req.headers['x-auth'] !== TOKEN) return send(res, 401, { error: 'unauthorized' });

  const declared = parseInt(req.headers['content-length'] || '0', 10);
  if (declared > MAX_BYTES) return send(res, 413, { error: 'body too large' });

  let data;
  try {
    data = await readBody(req, MAX_BYTES);
  } catch (e) {
    return send(res, 413, { error: 'body too large' });
  }

  if (!data || !data.length) return send(res, 400, { error: 'empty body; POST the PDF bytes' });

  // a JSON envelope is also accepted, for callers that cannot post raw binary
  if (data[0] === 0x7b /* { */) {
    try {
      const env = JSON.parse(data.toString('utf8'));
      data = Buffer.from(String(env.pdfBase64 || ''), 'base64');
    } catch (e) {
      return send(res, 400, { error: 'bad JSON body: ' + e.message });
    }
  }

  process.stderr.write(`POST /extract bytes=${data.length} content-type=${req.headers['content-type']}\n`);
  try {
    const result = await extract(data);
    return send(res, result.error ? 422 : 200, result);
  } catch (e) {
    process.stderr.write(String((e && e.stack) || e) + '\n');
    return send(res, 500, { error: `${e.name}: ${e.message}` });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`${SERVER_VERSION} listening on 0.0.0.0:${PORT} (auth ${TOKEN ? 'on' : 'off'})\n`);
});
