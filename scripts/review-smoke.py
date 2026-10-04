#!/usr/bin/env python3
"""原任务审阅的隔离服务验收；传入已构建的 atrium，仅用假工具和本地 bare 远端。"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def main():
    binary = str(Path(sys.argv[1]).resolve())
    real_git = shutil.which("git")
    with tempfile.TemporaryDirectory(prefix="atrium-review-", dir=os.environ["TMPDIR"]) as tmp:
        root = Path(tmp)
        tools = root / "bin"
        tools.mkdir()
        home = root / "home"
        home.mkdir()
        bare = root / "remote.git"
        env = {"PATH": f"{tools}:/usr/bin:/bin", "HOME": str(home), "TMPDIR": tmp,
               "ATRIUM_DATA": str(root / "data"), "ATRIUM_PORT": "0",
               "GIT_CONFIG_NOSYSTEM": "1", "LANG": "en_US.UTF-8"}
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            env["ATRIUM_PORT"] = str(s.getsockname()[1])

        def run(*args, cwd=None):
            return subprocess.check_output(args, cwd=cwd, env=env, text=True, stderr=subprocess.PIPE).strip()

        def git(*args, cwd=None):
            return run(real_git, "-c", "user.name=test", "-c", "user.email=test@example.invalid", *args, cwd=cwd)

        def tool(name, body):
            p = tools / name
            p.write_text(f"#!{sys.executable}\nimport sys\nif '--version' in sys.argv: print('fake 1.0'); sys.exit(0)\n" + body)
            p.chmod(0o755)

        git("init", "--bare", "-b", "main", str(bare))
        seed = root / "seed"
        git("clone", str(bare), str(seed))
        (seed / "README").write_text("初始\n")
        git("add", ".", cwd=seed)
        git("commit", "-m", "初始", cwd=seed)
        git("push", "origin", "main", cwd=seed)
        (home / ".gitconfig").write_text(
            f'[user]\nname = test\nemail = test@example.invalid\n'
            f'[url "{bare}"]\ninsteadOf = https://github.com/o/r.git\n')
        tool("git", f'''import os,sys
if sys.argv[-3:] == ["remote","get-url","origin"]:
    print("https://github.com/o/r.git")
else:
    os.execv({real_git!r}, [{real_git!r}] + sys.argv[1:])
''')
        tool("gh", f'''import json,sys,subprocess,tempfile,pathlib
root=pathlib.Path({tmp!r}); bare={str(bare)!r}; git={real_git!r}
def g(*args,cwd=None):
    return subprocess.check_output([git,*args],cwd=cwd,text=True,stderr=subprocess.PIPE).strip()
args=sys.argv[1:]; cmd=args[:2]
def flag(k): return args[args.index(k)+1]
def pr(n):
    branch="task-t"+str(n); state=root/('pr-'+str(n))
    return dict(number=n,url='https://github.com/o/r/pull/'+str(n),state='MERGED' if state.exists() else 'OPEN',isDraft=False,
      headRefName=branch,headRefOid=g('--git-dir',bare,'rev-parse',branch),baseRefName='main',
      body='## 端到端验证\\n隔离实例通过\\n',mergeCommit=dict(oid=state.read_text()) if state.exists() else None)
if cmd == ['repo','view']: print('main')
elif cmd == ['repo','clone']: g('clone',bare,args[3])
elif cmd == ['pr','list']: print(json.dumps([pr(int(flag('--head').split('t')[-1]))]))
elif cmd == ['pr','view']: print(json.dumps(pr(int(args[2].split('/')[-1]))))
elif cmd == ['pr','checks']: print(json.dumps([dict(name='fake-check',bucket='pass',link='')]))
elif cmd == ['pr','merge']:
    n=int(args[2]); p=pr(n)
    assert flag('--match-head-commit') == p['headRefOid']
    with tempfile.TemporaryDirectory(dir=root) as tmp:
        g('clone',bare,tmp); g('merge','--squash','origin/'+p['headRefName'],cwd=tmp)
        g('commit','-m','合入',cwd=tmp); g('push','origin','main',cwd=tmp)
        (root/('pr-'+str(n))).write_text(g('rev-parse','HEAD',cwd=tmp))
else: raise RuntimeError('假 gh 不支持 '+str(args))
''')
        tool("author-tool", '''import subprocess,os,pathlib
p=pathlib.Path('change'); p.write_text(p.read_text()+'重做\\n' if p.exists() else '实现\\n')
for args in [['add','change'],['commit','-m','实现'],['push','origin','HEAD']]:
    subprocess.run(['git',*args],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('交付结论：完成')
''')
        tool("reviewer-tool", f'''import pathlib,sys,os,time,subprocess
root=pathlib.Path({tmp!r}); task=os.environ['ATRIUM_TASK']; counter=root/(task+'-reviews')
n=int(counter.read_text())+1 if counter.exists() else 1; counter.write_text(str(n))
prompt=pathlib.Path(sys.argv[1]).read_text()
assert '本轮只读审阅' in prompt and '只交 PR：' not in prompt
# 给 top/show 留出观测窗口；不写代码、不调 gh 写接口。
time.sleep(1)
before=subprocess.check_output(['git','status','--porcelain'],text=True)
print('看过了' if '三次无结论' in prompt else '缺测试\\n审阅结论：打回' if '打回再审阅' in prompt and n == 1 else '审阅结论：通过')
assert subprocess.check_output(['git','status','--porcelain'],text=True) == before
''')

        def cli(*args):
            data = json.loads(run(binary, *args, "--json"))
            assert data["ok"], data
            return data["result"]

        observed = {}

        def wait(id, predicate, seconds=120):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                result = cli("task", "show", id)
                for h in result["history"]:
                    observed[h["id"]] = h
                if result["task"]["status"] == "blocked" and result["task"].get("stage") != "review":
                    raise AssertionError(result)
                if predicate(result):
                    return result
                time.sleep(.2)
            raise AssertionError(result)

        cli("start")
        try:
            for name, command, trust, model in [("author", "author-tool", "low", "a"), ("reviewer", "reviewer-tool", "medium", "b")]:
                profile = root / (name + ".md")
                profile.write_text(f'---\nprotocol: cli\ncommand: {command}\nargs: ["{{prompt_file}}"]\ntrust: {trust}\nmodel: {model}\nchecks: [finished, pr_exists]\n---\n')
                cli("workers", "edit", "harness/"+name, "--file", str(profile))
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    host = cli("host", "ls", "h1")
                    if host.get("info", {}).get("clis", {}).get(name, {}).get("installed"):
                        break
                    time.sleep(.2)
                else:
                    raise AssertionError(host)
            for title in ["通过合入", "打回再审阅", "三次无结论"]:
                observed.clear()
                id = cli("task", "add", title, "--repo", "o/r")["id"]
                cli("task", "run", id, "--worker", "author")
                active = wait(id, lambda x: x["task"].get("stage") == "review")
                assert active["task"]["worker"] == "author+a", active
                top = cli("top")
                assert "审阅 t" not in json.dumps(top, ensure_ascii=False), top
                result = wait(id, lambda x: x["task"]["status"] in ["done", "blocked"])
                task = result["task"]
                launches = [json.loads(h["body"]) for h in observed.values() if h["kind"] == "launch"]
                reviews = [r for r in launches if r["why"] == "review"]
                verdicts = [json.loads(h["body"])["pass"] for h in observed.values() if h["kind"] == "review"]
                assert verdicts == ([] if title == "三次无结论" else [False, True] if title == "打回再审阅" else [True]), verdicts
                assert all(r["worker"] == "reviewer+b" for r in reviews), launches
                if title == "三次无结论":
                    assert (task["status"], task["stage"], len(reviews)) == ("blocked", "review", 3), result
                else:
                    assert task["status"] == "done", result
                    assert (root / ("pr-"+id[1:])).exists()
                if title == "打回再审阅":
                    assert len(reviews) == 2 and any(r["why"] == "bounce" and r["worker"] == "author+a" for r in launches), result
                count = len(cli("task", "ls", "--status", "todo,queued,running,done,failed,blocked,cancelled"))
                assert count == int(id[1:]), count
                print(f'{id} {title}: {task["status"]}/{task["stage"]}, 审阅轮={len(reviews)}, 任务数={count}；top/show 无平行任务', flush=True)
        finally:
            cli("stop")
            print("隔离服务已停止", flush=True)


if __name__ == "__main__":
    main()
