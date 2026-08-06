from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json


state = {"ext": None}


def dispatch(request):
    method = request["method"]
    params = request.get("params", {})

    if method == "init":
        state["ext"] = params.get("ext")
        return {"initialized": True}
    if method == "home":
        return {"method": "home", "ext": state["ext"]}
    if method == "search":
        return {
            "method": "search",
            "word": params.get("wd"),
            "quick": params.get("quick", False),
        }
    if method == "player":
        return {"method": "player", "flag": params.get("flag"), "id": params.get("id")}
    if method == "destroy":
        return {"destroyed": True}
    raise ValueError(f"unsupported method: {method}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/rpc":
            self.send_error(404)
            return

        size = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(size).decode("utf-8"))
        try:
            response = {"id": request["id"], "ok": True, "result": dispatch(request)}
        except Exception as error:
            response = {
                "id": request.get("id", "unknown"),
                "ok": False,
                "error": {"code": "SPIDER_ERROR", "message": str(error)},
            }

        body = json.dumps(response, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(json.dumps({"ready": True, "port": server.server_port}), flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
