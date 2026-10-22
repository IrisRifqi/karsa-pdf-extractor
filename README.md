# karsa-pdf-extractor

A small HTTP service that reads the **plankton table** out of a lab-report PDF and
returns it as labelled rows with per-column values. It exists because n8n's built-in
PDF text extraction flattens the table: text items on one baseline are joined with no
separator and reordered by the PDF content stream, so a row's numbers lose their
columns and their species names. PDF.js (via `pdfjs-dist`) exposes the same text items
*with* their x/y, which is enough to rebuild rows and columns.

Nothing else in the Karsa pipeline needs it. STP and BBMS plankton are parsed from the
text layer inside n8n.

## Contract

```
POST /extract     body = raw PDF bytes (Content-Type: application/pdf)
                  or {"pdfBase64": "..."}
                  -> 200 {"kolam": ["A8","B2",...], "page": 2,
                          "rows": [{"label": "Chlorella", "values": [240000, null, ...]}, ...]}
                  -> 422 {"error": "no plankton table found", "kolam": [], "rows": []}
                  -> 400 empty body | 401 unauthorized | 413 too large | 500 parse error

GET  /health      -> 200 {"ok": true}
```

`values` always has one entry per `kolam`; a cell with no printed value is `null`.

## Build

```bash
docker build -f Dockerfile.node -t pdf-extractor:2.0.0 .
```

## Run

```bash
docker run -d --name pdf-extractor --restart always -p 8765:8765 pdf-extractor:2.0.0
```

Then check it: `curl http://127.0.0.1:8765/health` -> `{"ok":true}`

## Configuration (all optional)

| env var | default | purpose |
|---|---|---|
| `PORT` | `8765` | listen port |
| `MAX_BYTES` | `41943040` (40 MB) | max request body |
| `EXTRACTOR_TOKEN` | unset | when set, `/extract` requires header `X-Auth: <token>` |

## Operational requirements

- **Always on.** The workflow polls every 5 minutes; a sleeping or stopped container
  looks identical to a working one from the caller's side, because the calling node is
  `onError: continueRegularOutput`.
- **Reachable from the n8n instance** over plain HTTP(S). No database, no volume, no
  persistent state — kill and restart it whenever you like.
- **Body size.** Allow up to 40 MB per request. Reverse proxies default to ~1 MB
  (`client_max_body_size`), and some platforms cap request bodies (Cloud Run: 32 MB).
- **Health check.** `GET /health`; the image also declares a Docker `HEALTHCHECK`.

## Do not upgrade pdfjs-dist

`package.json` pins `pdfjs-dist` to an exact version. Output is compared against printed
lab values, and a minor bump can change word spacing and therefore table alignment.
Upgrade deliberately, and re-run the parity check (see `legacy/README.md`) before
shipping.

## Offline / air-gapped install

The build needs the `node:22-slim` base image and npm access. If the target host has
neither, export the built image on a machine that does, and load it instead:

```bash
docker save pdf-extractor:2.0.0 -o pdf-extractor-2.0.0.tar
# on the target host
docker load -i pdf-extractor-2.0.0.tar
docker run -d --name pdf-extractor --restart always -p 8765:8765 pdf-extractor:2.0.0
```

## Files

| file | role |
|---|---|
| `pdf_table.js` | extraction logic (row/column reconstruction, number parsing) |
| `pdf_server.js` | HTTP wrapper |
| `package.json` / `package-lock.json` | pins `pdfjs-dist` |
| `Dockerfile.node` | build (Node 22 slim, `npm ci --omit=dev`) |
| `legacy/pdf_table.py` | the pdfplumber version this was ported from — test oracle only, not built |
