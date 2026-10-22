Reference implementation only -- NOT part of the extractor runtime.

pdf_table.py is the pdfplumber version the Node service (../pdf_table.js) was ported
from and verified against, across the Grobest fixtures. Use it as a test oracle when
re-checking output after a pdfjs-dist bump:

    pip install pdfplumber==0.11.10
    python pdf_table.py <file.pdf> --debug

Build and run the service from ../Dockerfile.node. Do not rebuild this as a service.
