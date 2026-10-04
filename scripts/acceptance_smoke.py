#!/usr/bin/env python3
"""任务级验收 CLI 端到端：仅临时 HOME/数据、随机端口与假执行者。"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="atrium-acceptance-", dir=os.environ["TMPDIR"]) as work:
    root = Path(work)
    (root / "home").mkdir()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"),
           "TMPDIR": work, "TMP": work, "TEMP": work,
           "ATRIUM_DATA": str(root / "data"), "ATRIUM_PORT": str(port),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": str(root / "gitconfig")}

    def call(*args, ok=True):
        p = subprocess.run([binary, *args, "--json"], env=env,
                           text=True, capture_output=True, timeout=45)
        data = json.loads(p.stdout)
        assert data["ok"] == ok, (args, data)
        return data.get("result") if ok else data["error"]

    def log(message):
        print(message, flush=True)

    try:
        call("start")
        profile = root / "fake.md"
        profile.write_text('---\nprotocol: cli\ncommand: bash\nargs: ["-c", "echo DONE; echo 阶段已交付但目标尚未验收; echo 交付结论：完成", "{prompt}"]\ndone_match: "^DONE$"\n---\n只输出假交付。\n')
        call("workers", "edit", "harness/fakesh", "--file", str(profile))
        deadline = time.monotonic() + 30
        while True:
            host = call("host", "ls", "h1")
            if ((host.get("info") or {}).get("clis") or {}).get("fakesh", {}).get("installed"):
                break
            assert time.monotonic() < deadline, "假执行者自检超时"
            time.sleep(0.2)
        task = call("task", "add", "t852形状：阶段完成，目标暂缓")["id"]
        call("task", "note", task, "旧决定：目标未完成，不合入")
        for n in range(25):
            call("task", "note", task, f"后续进展 {n}")
        detail = call("task", "show", task, "--history-limit", "10")
        assert "acceptance" not in detail, "历史文字不应自动变成决定"
        seen = []
        while True:
            seen = detail["history"] + seen
            before = detail.get("history_before")
            if not before:
                break
            detail = call("task", "show", task, "--history-limit", "10", "--before", str(before))
        assert any(e.get("body") == "旧决定：目标未完成，不合入" for e in seen)
        assert len({e["id"] for e in seen}) == len(seen)
        call("task", "set", task, "--accept", "hold", "--note", "目标未完成，不合入")
        log("有界翻页核对旧决定 → 原决策人明确 hold 登记；未猜测转换：PASS")
        call("task", "run", task, "--worker", "fakesh")
        got = call("task", "wait", task, "--timeout", "30")["task"]
        assert (got["status"], got["stage"]) == ("running", "accept"), got
        log("完成末行 → running/accept；阶段交付未关闭目标：PASS")
        rejected = call("task", "set", task, "--status", "done", ok=False)
        assert rejected["code"] == "conflict", rejected
        log("task set --status done 绕过被拒：conflict")
        call("stop")
        call("start")
        detail = call("task", "show", task)
        assert detail["acceptance"]["actor"] == "u1"
        assert detail["acceptance"]["reason"] == "目标未完成，不合入"
        log("stop/start 后决定及决策人在 task show 保留：PASS")
        call("task", "stop", task, "重派阶段修复")
        call("task", "run", task, "--worker", "fakesh")
        got = call("task", "wait", task, "--timeout", "30")["task"]
        assert (got["status"], got["stage"]) == ("running", "accept"), got
        log("stop/run 重派仍为 running/accept：PASS")
        call("task", "set", task, "--accept", "resume", "--note", "原决策人明确解除")
        assert "acceptance" not in call("task", "show", task)
        got = call("task", "accept", task)
        assert got["status"] == "done", got
        log("明确 resume 后 task accept 正常完成：PASS")
    finally:
        call("stop")
        log("只在隔离环境：服务已停止，临时目录回收")
