/**
 * KiCad IPC 的 Python 端（S153）。
 *
 * 为什么把协议放在 Python 里：KiCad 的官方 API 是 protobuf over 本地 socket，
 * 参考实现是 `kipy`，它随 KiCad 自带一份 Python 就能 import。TS 侧只负责
 * 拼参数、跑进程、解析信封——这样 KiCad 的 API 变了只改这一支脚本，
 * 调用方与错误分类都不动。
 *
 * 脚本约定：`python pcb_ipc.py <payload.json>`，往 stdout 打**一行** JSON：
 * `{"ok":true,"data":{...}}` 或 `{"ok":false,"error":{"kind":"…","message":"…"}}`。
 * `kind ∈ FAILED_PRECONDITION | NOT_FOUND | INVALID_ARGUMENT | INTERNAL`。
 */
export const PCB_IPC_SCRIPT = String.raw `import json
import sys


def emit(ok, data=None, kind="", message=""):
    if ok:
        sys.stdout.write(json.dumps({"ok": True, "data": data or {}}, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(json.dumps({"ok": False, "error": {"kind": kind, "message": message}}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def mm_to_nm(value):
    return int(round(float(value) * 1000000.0))


def nm_to_mm(value):
    return round(float(value) / 1000000.0, 4)


def fail(exc):
    name = type(exc).__name__
    text = str(exc)
    if "connect" in text.lower() or "refused" in text.lower() or "no such" in text.lower():
        return emit(False, kind="FAILED_PRECONDITION", message="连不上 KiCad 的 IPC 接口：" + name + ": " + text)
    return emit(False, kind="INTERNAL", message=name + ": " + text)


def layer_of(board, name):
    from kipy.board_types import BoardLayer
    key = "BL_" + name.replace(".", "_").upper()
    if not hasattr(BoardLayer, key):
        raise ValueError("不认识的铜层：" + name)
    return getattr(BoardLayer, key)


def net_of(board, name):
    if not name:
        return None
    for net in board.get_nets():
        if net.name == name:
            return net
    raise ValueError("板上没有名为 " + name + " 的网络")


def describe_footprint(fp):
    pos = fp.position
    return {
        "ref": fp.reference_field.text,
        "value": fp.value_field.text if fp.value_field is not None else "",
        "x": nm_to_mm(pos.x),
        "y": nm_to_mm(pos.y),
        "rotation": round(float(fp.orientation.degrees), 2) if fp.orientation is not None else 0.0,
    }


def safe_bool(fn):
    try:
        return bool(fn())
    except Exception:
        return False


def board_summary(board):
    tracks = board.get_tracks()
    by_layer = {}
    for track in tracks:
        try:
            name = board.get_layer_name(track.layer)
        except Exception:
            name = "unknown"
        by_layer[name] = by_layer.get(name, 0) + 1
    return {
        "name": board.name,
        # 10.0.7 上 GetDocumentModifiedState 没有 handler，取不到就报 false，不因此让整次诊断失败。
        "modified": safe_bool(board.is_document_modified),
        "counts": {
            "footprints": len(board.get_footprints()),
            "tracks": len(tracks),
            "vias": len(board.get_vias()),
            "zones": len(board.get_zones()),
            "nets": len(board.get_nets()),
        },
        "tracksByLayer": by_layer,
    }


def action_status(board, kicad):
    docs = []
    try:
        for doc in kicad.get_open_documents():
            docs.append({"type": str(doc.type), "file": doc.board_filename if doc.type == 0 else doc.schematic_filename})
    except Exception:
        docs = []
    return {
        "version": str(kicad.get_version()),
        "openDocuments": docs,
        "board": board_summary(board),
    }


def action_inspect(board, kicad, payload):
    ref = payload.get("ref") or ""
    footprints = [describe_footprint(fp) for fp in board.get_footprints()]
    if ref:
        footprints = [item for item in footprints if item["ref"] == ref]
        if not footprints:
            raise LookupError("板上没有位号为 " + ref + " 的元件")
    nets = [{"name": net.name, "code": net.code} for net in board.get_nets()]
    selection = []
    try:
        for item in board.get_selection():
            selection.append(str(item).split("\n")[0])
    except Exception:
        selection = []
    return {"footprints": footprints[:120], "nets": nets[:200], "selection": selection, "summary": board_summary(board)}


def find_footprint(board, ref):
    for fp in board.get_footprints():
        if fp.reference_field.text == ref:
            return fp
    raise LookupError("板上没有位号为 " + ref + " 的元件")


def action_move(board, payload):
    ref = str(payload.get("ref") or "")
    if not ref:
        raise ValueError("move 需要 ref")
    x = mm_to_nm(payload.get("x"))
    y = mm_to_nm(payload.get("y"))
    fp = find_footprint(board, ref)
    planned = {"ref": ref, "x": nm_to_mm(x), "y": nm_to_mm(y)}
    if not payload.get("apply"):
        return {"planned": planned, "applied": False}
    from kipy.geometry import Vector2
    fp.position = Vector2(x, y)
    board.begin_commit()
    board.update_items([fp])
    board.push_commit("dsh-stm32: 移动 " + ref)
    return {"planned": planned, "applied": True}


def parse_points(payload):
    raw = str(payload.get("points") or "")
    points = []
    for part in raw.split(";"):
        part = part.strip()
        if part == "":
            continue
        pieces = part.split(",")
        if len(pieces) != 2:
            raise ValueError("points 要写成 x1,y1;x2,y2")
        points.append((mm_to_nm(pieces[0]), mm_to_nm(pieces[1])))
    if len(points) < 2:
        raise ValueError("points 至少要两个点")
    return points


def action_route(board, payload):
    from kipy.board_types import Track
    from kipy.geometry import Vector2
    points = parse_points(payload)
    width = mm_to_nm(payload.get("width") or 0.25)
    layer = layer_of(board, str(payload.get("layer") or "F.Cu"))
    net = net_of(board, str(payload.get("net") or ""))
    planned = {"segments": len(points) - 1, "width": nm_to_mm(width), "layer": str(payload.get("layer") or "F.Cu")}
    if not payload.get("apply"):
        return {"planned": planned, "applied": False}
    tracks = []
    for index in range(len(points) - 1):
        track = Track()
        track.start = Vector2(points[index][0], points[index][1])
        track.end = Vector2(points[index + 1][0], points[index + 1][1])
        track.width = width
        track.layer = layer
        if net is not None:
            track.net = net
        tracks.append(track)
    board.begin_commit()
    board.create_items(tracks)
    board.push_commit("dsh-stm32: 布线 " + str(len(tracks)) + " 段")
    return {"planned": planned, "applied": True}


def action_via(board, payload):
    from kipy.board_types import Via
    from kipy.geometry import Vector2
    x = mm_to_nm(payload.get("x"))
    y = mm_to_nm(payload.get("y"))
    diameter = mm_to_nm(payload.get("size") or 0.6)
    drill = mm_to_nm(payload.get("drill") or 0.3)
    net = net_of(board, str(payload.get("net") or ""))
    planned = {"x": nm_to_mm(x), "y": nm_to_mm(y), "size": nm_to_mm(diameter), "drill": nm_to_mm(drill)}
    if not payload.get("apply"):
        return {"planned": planned, "applied": False}
    via = Via()
    via.position = Vector2(x, y)
    via.diameter = diameter
    via.drill_diameter = drill
    if net is not None:
        via.net = net
    board.begin_commit()
    board.create_items([via])
    board.push_commit("dsh-stm32: 加过孔")
    return {"planned": planned, "applied": True}


def action_refill(board, payload):
    if not payload.get("apply"):
        return {"planned": {"zones": len(board.get_zones())}, "applied": False}
    board.refill_zones()
    return {"planned": {"zones": len(board.get_zones())}, "applied": True}


def action_save(board, payload):
    if not payload.get("apply"):
        return {"planned": {"file": board.name}, "applied": False}
    board.save()
    return {"planned": {"file": board.name}, "applied": True}


def guard_board(board, payload):
    expect = str(payload.get("expectBoard") or "")
    if expect and board.name != expect:
        raise ValueError("当前活动文档是 " + board.name + "，不是 " + expect + "；先在 KiCad 里切到目标板再操作")


def main():
    payload = json.loads(open(sys.argv[1], "r", encoding="utf-8").read())
    action = str(payload.get("action") or "status")
    try:
        from kipy import KiCad
        kicad = KiCad(timeout_ms=int(payload.get("timeoutMs") or 30000))
        board = kicad.get_board()
    except Exception as exc:
        return fail(exc)
    try:
        guard_board(board, payload)
        if action == "status":
            return emit(True, action_status(board, kicad))
        if action == "inspect":
            return emit(True, action_inspect(board, kicad, payload))
        if action == "move":
            return emit(True, action_move(board, payload))
        if action == "route":
            return emit(True, action_route(board, payload))
        if action == "via":
            return emit(True, action_via(board, payload))
        if action == "refill":
            return emit(True, action_refill(board, payload))
        if action == "save":
            return emit(True, action_save(board, payload))
        raise ValueError("不认识的 action：" + action)
    except LookupError as exc:
        return emit(False, kind="NOT_FOUND", message=str(exc))
    except ValueError as exc:
        return emit(False, kind="INVALID_ARGUMENT", message=str(exc))
    except Exception as exc:
        return fail(exc)


main()
`;
