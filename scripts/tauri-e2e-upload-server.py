from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys


OUTPUT_ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
MAX_BYTES = 16 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        self.send_error(404)

    def do_POST(self):
        targets = {
            "/upload/evidence.json": OUTPUT_ROOT / "tauri-clean-win11-local-e2e.json",
            "/upload/log.txt": OUTPUT_ROOT / "tauri-clean-win11-local-e2e.log",
        }
        target = targets.get(self.path)
        if target is None:
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BYTES:
            self.send_error(413)
            return
        target.write_bytes(self.rfile.read(length))
        self.send_response(201)
        self.end_headers()
        self.wfile.write(b"stored\n")

    def log_message(self, _format, *_args):
        return


HTTPServer(("192.168.241.1", 8766), Handler).serve_forever()
