#!/usr/bin/env python3
"""已合入复核：实际 CLI/服务调用链，仅隔离数据、假 gh 与本地 bare。"""
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time


def main():
    binary = str(Path(sys.argv[1]).resolve())
    real_git = shutil.which('git')
    with tempfile.TemporaryDirectory(prefix='atrium-recheck-', dir=os.environ['TMPDIR']) as tmp:
        root = Path(tmp)
        tools, home = root / 'bin', root / 'home'
        tools.mkdir(); home.mkdir()
        bare, seed = root / 'remote.git', root / 'seed'
        env = {'PATH': f'{tools}:/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': tmp,
               'ATRIUM_DATA': str(root / 'data'), 'ATRIUM_PORT': '0',
               'GIT_CONFIG_NOSYSTEM': '1', 'LANG': 'en_US.UTF-8'}

        def run(*args, cwd=None):
            return subprocess.check_output(args, cwd=cwd, env=env, text=True, stderr=subprocess.PIPE).strip()

        def git(*args, cwd=None):
            return run(real_git, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', *args, cwd=cwd)

        def tool(name, body):
            p = tools / name
            p.write_text(f'#!{sys.executable}\n' + body)
            p.chmod(0o755)

        git('init', '--bare', '-b', 'main', str(bare))
        git('clone', str(bare), str(seed))
        (seed / 'README').write_text('初始\n')
        git('add', '.', cwd=seed); git('commit', '-m', '初始', cwd=seed); git('push', 'origin', 'main', cwd=seed)
        (home / '.gitconfig').write_text('[user]\nname=test\nemail=test@example.invalid\n')
        tool('git', f'''import os,sys
if sys.argv[-3:] == ['remote','get-url','origin']: print('https://github.com/o/r.git')
else: os.execv({real_git!r}, [{real_git!r}]+sys.argv[1:])
''')
        tool('gh', f'''import json,sys,pathlib
root=pathlib.Path({tmp!r}); args=sys.argv[1:]
if args[:2]==['repo','view']: print('main')
elif args[:2]==['pr','view']: print((root/('pr-'+args[2].split('/')[-1]+'.json')).read_text())
elif args[:2]==['pr','list']:
 branch=args[args.index('--head')+1]; print(json.dumps([json.loads((root/('pr-'+branch.split('t')[-1]+'.json')).read_text())]))
elif args[:2]==['pr','merge']:
 (root/'unexpected-merge').write_text(str(args)); raise RuntimeError('复核禁止重复合入')
else: raise RuntimeError('假 gh 不支持 '+str(args))
''')
        tool('reviewer-tool', '''import sys
if '--version' in sys.argv: print('fake 1'); sys.exit(0)
print('只读核对通过\\n审阅结论：通过')
''')

        def cli(*args, fail=False):
            p = subprocess.run([binary, *args, '--json'], env=env, text=True, capture_output=True)
            if fail:
                assert p.returncode != 0, (args, p.stdout, p.stderr)
                print('拒绝', ' '.join(args), p.stdout.strip() or p.stderr.strip(), flush=True)
                return
            assert p.returncode == 0, (args, p.stdout, p.stderr)
            data = json.loads(p.stdout)
            assert data['ok'], data
            return data['result']

        cli('start')
        cli('stop')
        db = sqlite3.connect(root / 'data' / 'atrium.db')
        db.execute("INSERT INTO departments(id,name,created_at,updated_at) VALUES('o100','隔离验收',0,0)")
        db.execute("INSERT INTO acceptors VALUES('o100','leader')")
        for name, trust in [('author','high'), ('low-author','low'), ('reviewer','medium')]:
            profile = f'---\nprotocol: cli\ncommand: reviewer-tool\nargs: ["{{prompt_file}}"]\ntrust: {trust}\nmodel: {name}\nchecks: [finished, pr_exists]\n---\n'
            db.execute("INSERT INTO worker_profiles(name,spec,updated_by,updated_at) VALUES(?,?,'u1',0)", ('harness/'+name,profile))
        # 相异工具保证审阅者不会选回作者；只有 reviewer 的可执行命令存在。
        db.execute("UPDATE worker_profiles SET spec=replace(spec,'command: reviewer-tool','command: absent-author') WHERE name IN ('harness/author','harness/low-author')")
        cases = [('auto-t973','完成',''), ('auto-review-hold','完成','review'),
                 ('restore-t973','完成','restore'), ('restore-t914','受阻','restore'),
                 ('restore-review-hold','受阻','restore-review'),
                 ('auto-blocked','受阻',''), ('auto-unfinished','未完成',''), ('auto-missing','missing',''),
                 ('restore-dirty','受阻','dirty'), ('restore-unpushed','受阻','unpushed'),
                 ('restore-new-head','受阻','head'), ('restore-other-block','受阻','other'), ('restore-external-block','受阻','external'),
                 ('auto-zero-ahead','完成','zero'), ('auto-dirty','完成','auto-dirty'), ('auto-unpushed','完成','auto-unpushed'), ('auto-new-head','完成','auto-head')]
        records = []
        for n, (name, ending, mode) in enumerate(cases, 1):
            id, branch = f't{n}', f'task-t{n}'
            work = root / ('wt-'+id)
            git('clone', str(bare), str(work)); git('checkout', '-b', branch, cwd=work)
            (work / ('change-'+id)).write_text(name+'\n')
            git('add', '.', cwd=work); git('commit', '-m', name, cwd=work); git('push', 'origin', branch, cwd=work)
            head = git('rev-parse', 'HEAD', cwd=work)
            git('fetch','origin',cwd=seed); git('merge','--squash','origin/'+branch,cwd=seed)
            git('commit','-m','合入 '+name,cwd=seed);git('push','origin','main',cwd=seed)
            merge = git('rev-parse','HEAD',cwd=seed)
            if mode=='zero':
                git('--git-dir',str(bare),'update-ref','refs/heads/main',head)
                git('fetch','origin',cwd=work)
                assert git('rev-list','--count','origin/main..HEAD',cwd=work)=='0'
                git('reset','--hard',head,cwd=seed)
            pr = dict(number=n,url=f'https://github.com/o/r/pull/{n}',state='MERGED',isDraft=False,
                      headRefName=branch,headRefOid=head,baseRefName='main',body='## 端到端验证\n隔离实测\n',mergeCommit=dict(oid=merge))
            (root / f'pr-{n}.json').write_text(json.dumps(pr))
            manual = name.startswith('restore-')
            worker = 'low-author+low-author' if 'review' in mode else 'author+author'
            db.execute("INSERT INTO tasks(id,department,title,status,stage,repo,worker,host,pr,created_at,updated_at) VALUES(?,?,?,?,'gate','o/r',?,'h1',?,0,0)",
                       (id,'o100',name,'blocked' if manual else 'running',worker,pr['url']))
            reply = '资料已核对；仅 OPEN 生命周期错配\n交付结论：'+ending if ending!='missing' else '没有完成末行'
            def event(kind, body):
                db.execute("INSERT INTO task_events(task,at,kind,actor,body) VALUES(?,0,?,'runtime',?)", (id,kind,body))
            event('launch', json.dumps(dict(n=1,why='start',worker=worker,host='h1',risk='low',dir=str(work),branch=branch,log=str(root/(id+'-author.log')))))
            event('result',reply)
            event('exit',json.dumps(dict(n=1)))
            event('worktree',json.dumps(dict(host='h1',dir=str(work))))
            old = dict(pass_=False,results=[dict(check='pr_exists',ok=False),dict(check='finished',ok=True)],
                       facts=dict(branch=branch,head=head,pushed=True,pr=dict(url=pr['url'],state='MERGED',head=branch,head_oid=head,merge_commit=merge)))
            old['pass']=old.pop('pass_')
            if manual:
                if mode=='other':old['results'].append(dict(check='claims_verified',ok=False))
                if mode=='external':old['results'][0]['ok']=True
                event('gate',json.dumps(old))
            if 'hold' in name:
                db.execute("INSERT INTO task_acceptance(task,actor,reason,epoch,head) VALUES(?,'u1','原负责人暂缓',0,'')",(id,))
            if mode.endswith('dirty'): (work/'dirty').write_text('x')
            if mode.endswith('unpushed'): git('push','--force','origin','HEAD~1:refs/heads/'+branch,cwd=work)
            if mode.endswith('head'):
                (work/'new').write_text('x');git('add','new',cwd=work);git('commit','-m','新代码',cwd=work);git('push','origin',branch,cwd=work)
            records.append((id,name,mode,reply))
        db.commit();db.close()
        cli('start')
        try:
            for id,name,mode,reply in records:
                if name.startswith('restore-'):
                    args=('task','merge',id,'--restore-merged','--reason','仅 OPEN 关卡错配，非外部受阻','--evidence','实际资料已核对')
                    if mode in ('dirty','unpushed','head','other','external'):
                        cli(*args,fail=True)
                        assert cli('task','show',id)['task']['status']=='blocked'
                        continue
                    cli(*args)
                if name.startswith('auto-') and mode not in ('','review','zero') or name in ('auto-blocked','auto-unfinished','auto-missing'):
                    end=time.monotonic()+30
                    while time.monotonic()<end:
                        result=cli('task','show',id)
                        if result['task']['status'] in ('blocked','queued'):break
                        time.sleep(.2)
                    assert result['task']['status'] in ('blocked','queued'),result
                    assert result['task'].get('stage') not in ('accept','merge_queue'),result
                    print(name,'拒绝',result['task']['status'],result['task'].get('stage',''),flush=True)
                    continue
                end=time.monotonic()+60
                while time.monotonic()<end:
                    result=cli('task','show',id)
                    if result['task'].get('stage')=='accept':break
                    time.sleep(.2)
                assert result['task']['status']=='running' and result['task']['stage']=='accept',result
                launches=[json.loads(h['body']) for h in result['history'] if h['kind']=='launch']
                assert len([r for r in launches if r['why']!='review'])==1,launches
                original=[h['body'] for h in result['history'] if h['kind']=='result']
                assert reply in original,result
                if 'review' in mode:
                    assert any(h['kind']=='review' and json.loads(h['body'])['pass'] for h in result['history']),result
                if 'hold' in name:
                    assert result['acceptance']['reason']=='原负责人暂缓' and not result['acceptance'].get('epoch'),result
                    print(name,'hold 保留，应用尚未授权',flush=True)
                got=cli('task','accept',id)
                assert got['status']=='done' and got['stage']!='merge_queue',got
                print(name, ('原任务审阅→' if 'review' in mode else '')+'待验收→accept完成，原result保留，无重复合入',flush=True)
            assert len(cli('task','ls','--status','todo,queued,running,done,failed,blocked,cancelled'))==len(records)
            assert not (root/'unexpected-merge').exists()
            print('隔离 CLI 组合验证通过',flush=True)
        finally:
            cli('stop')
            print('隔离服务已停止',flush=True)


if __name__=='__main__':
    main()
