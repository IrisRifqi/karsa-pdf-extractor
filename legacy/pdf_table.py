#!/usr/bin/env python3
"""
pdf_table.py -- coordinate-aware table extractor for lab-report PDFs.

n8n's "Extract PDF Text" node (pdf-parse 1.1.1) joins every text item on a shared
baseline with no separator and reorders items by the PDF content stream, so a table
row comes out as glued digits ("100000110000160000...") and the row labels land in a
separate, reordered block. The species counts therefore cannot be tied to species names.

This script reads the same PDF but keeps each word's x/y position, so a row's label and
its per-column values stay together and blank cells are explicit nulls.

Usage:
    python3 pdf_table.py <file.pdf>            # -> JSON on stdout
    python3 pdf_table.py <file.pdf> --debug    # + raw rows dump on stderr

Output:
    {
      "kolam":  ["F1", ..., "F7"],
      "page":   2,
      "rows":   [ {"label": "Chlorella", "values": [100000, ..., null]}, ... ]
    }

Rows are emitted top-to-bottom in visual order. `values` always has len(kolam) entries;
a cell with no printed value is null. Classification of rows (percent / total / group /
species) is left to the calling workflow, which owns the domain schema.
"""

import sys
import json
import re

try:
    import pdfplumber
except ImportError:
    sys.stderr.write("pdfplumber is required:  pip install pdfplumber\n")
    sys.exit(3)

CODE_RE = re.compile(r"^[A-Za-z]{1,3}\d{1,3}[A-Za-z]?$")
ROW_TOL = 3.0          # pt: words within this vertical distance are one row
COL_TOL_RATIO = 0.45   # fraction of column pitch counted as "belongs to this column"


def to_num(tok):
    """'78,57' -> 78.57 | '110.000' -> 110000 | '100000' -> 100000 | else None."""
    if tok is None:
        return None
    t = str(tok).strip()
    if not t:
        return None
    t = t.replace("%", "").strip()
    # thousands first: these reports write 110.000 for one hundred ten thousand and
    # use a comma for decimals, so a dot-grouped number must not fall through as 110.0
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})+", t):      # Indonesian thousands: 110.000
        return float(t.replace(".", ""))
    if re.fullmatch(r"-?\d+,\d+", t):                # decimal comma: 78,57
        return float(t.replace(",", "."))
    if re.fullmatch(r"-?\d+(\.\d+)?", t):
        return float(t)
    return None


def cluster_rows(words, tol=ROW_TOL):
    """Group words into visual rows by their y (top) coordinate."""
    if not words:
        return []
    words = sorted(words, key=lambda w: (w["top"], w["x0"]))
    rows, cur, cur_top = [], [words[0]], words[0]["top"]
    for w in words[1:]:
        if abs(w["top"] - cur_top) <= tol:
            cur.append(w)
        else:
            rows.append(cur)
            cur, cur_top = [w], w["top"]
    rows.append(cur)
    return [sorted(r, key=lambda w: w["x0"]) for r in rows]


def find_header(rows):
    """The column header row: every token is a short sample code (F1..F7, A1.., etc.)."""
    for idx, row in enumerate(rows):
        toks = [w["text"] for w in row]
        if len(toks) >= 2 and all(CODE_RE.match(t) for t in toks):
            return idx, row
    return None, None


def extract(pdf_path, debug=False):
    with pdfplumber.open(pdf_path) as pdf:
        target = None
        for pno, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            if "PLANKTON" in text.upper() and "JENIS" in text.upper():
                target = (pno, page)
                break
        if target is None:
            return {"error": "no plankton table found", "kolam": [], "rows": []}

        pno, page = target
        rows = cluster_rows(page.extract_words(use_text_flow=False, keep_blank_chars=False))
        hidx, header = find_header(rows)
        if header is None:
            return {"error": "no sample-code header row found", "kolam": [], "rows": []}

        kolam = [w["text"] for w in header]
        centers = [(w["x0"] + w["x1"]) / 2.0 for w in header]
        pitch = (centers[-1] - centers[0]) / (len(centers) - 1) if len(centers) > 1 else 0
        col_tol = pitch * COL_TOL_RATIO
        first_left = header[0]["x0"]

        out_rows = []
        detail_started = False
        for row in rows[hidx + 1:]:
            cells = [None] * len(kolam)
            label_parts = []
            for w in row:
                cx = (w["x0"] + w["x1"]) / 2.0
                placed = False
                if pitch > 0:
                    for ci, c in enumerate(centers):
                        if abs(cx - c) <= col_tol:
                            cells[ci] = (str(cells[ci]) + " " + w["text"]).strip() if cells[ci] is not None else w["text"]
                            placed = True
                            break
                if not placed:
                    label_parts.append(w["text"])
            label = " ".join(label_parts).strip()
            vals = [to_num(c) for c in cells]
            if not label and all(v is None for v in vals):
                continue
            # the detail table is closed by its own repeated "Total Plankton" footer;
            # everything past it is signature/letterhead, not table data
            if detail_started and re.match(r"^Total\s+Plankton$", label, re.I):
                break
            # the footer repeats the total values on an unlabelled line just above
            # that marker -- drop it so the grand total is not emitted twice
            if detail_started and not label and any(v is not None for v in vals):
                break
            if re.match(r"^\d+\.\s", label):
                detail_started = True
            if debug:
                sys.stderr.write("%-34s | %s\n" % (label, vals))
            out_rows.append({"label": label, "values": vals})

        return {"kolam": kolam, "page": pno + 1, "rows": out_rows}


def main():
    argv = sys.argv[1:]
    out_path = None
    if "--out" in argv:
        i = argv.index("--out")
        if i + 1 >= len(argv):
            sys.stderr.write("--out needs a path\n")
            return 2
        out_path = argv[i + 1]
        del argv[i:i + 2]
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        sys.stderr.write(__doc__)
        return 2

    res = extract(args[0], debug="--debug" in argv)
    payload = json.dumps(res, ensure_ascii=False) + "\n"
    if out_path:
        # write UTF-8 explicitly: shell redirection on Windows defaults to UTF-16,
        # which the downstream JSON.parse cannot read
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(payload)
    else:
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except AttributeError:
            pass
        sys.stdout.write(payload)
    return 0 if not res.get("error") else 1


if __name__ == "__main__":
    sys.exit(main())
