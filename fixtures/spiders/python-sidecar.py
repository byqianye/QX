import asyncio
import inspect
import json
import sys


state = {"ext": None}


async def dispatch(request):
    method = request["method"]
    params = request.get("params", {})

    if method == "init":
        state["ext"] = params.get("ext")
        return {"initialized": True}
    if method == "home":
        return {"class": [{"type_id": "fixture", "type_name": "Python"}], "list": [{
            "vod_id": "python-home",
            "vod_name": state["ext"] or "Python",
        }]}
    if method == "category":
        return {"page": params.get("page", 1), "list": [{
            "vod_id": params.get("typeId", "python"),
            "vod_name": "Python category",
        }]}
    if method == "search":
        await asyncio.sleep(0)
        return {"page": params.get("page", 1), "list": [{
            "vod_id": "python-search",
            "vod_name": params.get("key", params.get("wd", "")),
        }]}
    if method == "detail":
        return {"list": [{"vod_id": item, "vod_name": "Python detail"}
                         for item in params.get("ids", [])]}
    if method == "player":
        return {"parse": 0, "url": "https://media.example.invalid/python.mp4", "header": {}}
    if method == "localProxy":
        return {"url": params.get("url", ""), "status": 200, "headers": {}, "body": "python-proxy"}
    if method == "destroy":
        return {"destroyed": True}
    raise ValueError(f"unsupported method: {method}")


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


emit({"type": "ready", "protocol": "python-spider-rpc/1"})
for line in sys.stdin:
    if not line.strip():
        continue
    request = None
    try:
        request = json.loads(line)
        result = dispatch(request)
        if inspect.isawaitable(result):
            result = asyncio.run(result)
        response = {"id": request["id"], "ok": True, "result": result}
    except Exception as error:
        response = {
            "id": request.get("id", "unknown") if isinstance(request, dict) else "unknown",
            "ok": False,
            "error": {"code": "PYTHON_SPIDER_ERROR", "message": str(error)},
        }
    emit(response)
    if isinstance(request, dict) and request.get("method") == "destroy":
        break
