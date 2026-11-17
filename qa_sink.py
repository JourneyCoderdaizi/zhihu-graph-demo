import http.server, base64, pathlib, sys

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "qa")
OUT.mkdir(exist_ok=True)


class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode()
        name, _, b64 = raw.partition("|")
        p = OUT / name
        p.write_bytes(base64.b64decode(b64))
        print("saved", p, p.stat().st_size, flush=True)
        self.send_response(200); self._cors(); self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
print("PORT", srv.server_port, flush=True)
srv.serve_forever()
