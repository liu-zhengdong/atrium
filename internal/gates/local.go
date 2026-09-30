package gates

import (
	"context"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/worktree"
)

// local 交付方式：本机仓库、不经 GitHub。关卡在本机查任务分支的提交与改动；落地把任务分支合进本机主分支
// （主工作树当前所在的分支）；任务结束后由 dispatch 统一回收工作树与分支。

// localWorkspace 取本机交付的工作树登记：本机仓库只派本机（dispatch 的 hostNeed），登记在远程就是错的。
func localWorkspace(ctx context.Context, q store.Querier, id string) (Worktree, error) {
	w, err := mustWorkspace(ctx, q, id)
	if err == nil && w.Remote() {
		err = fmt.Errorf("%s 是本机交付，工作树却登记在 %s", id, w.Host)
	}
	return w, err
}

func (g *Gate) checkLocal(ctx context.Context, t ledger.Task) (checked, error) {
	w, err := localWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	facts, err := CollectLocal(ctx, g.R, w.Dir, t.Repo)
	if err != nil {
		return checked{}, err
	}
	v := Judge([]string{CheckCommitted}, facts)
	if err := record(ctx, g.DB, t.ID, KindGate, gateRecord{v, facts}); err != nil {
		return checked{}, err
	}
	if !v.Pass {
		return checked{reasons: v.Reasons}, nil
	}
	return checked{note: "关卡通过（本机交付）：" + facts.Diff}, nil
}

// landLocal 把任务分支合进本机主分支：主分支已在任务分支里就直接快进，否则先在任务工作树里合入主分支
// （冲突交回原执行者，不碰主工作树），再快进主分支。
func (g *Gate) landLocal(ctx context.Context, t ledger.Task) (landed, error) {
	worktree.LocalMutation.Lock()
	defer worktree.LocalMutation.Unlock()
	w, err := localWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return landed{}, err
	}
	f, git, err := branchFacts(ctx, g.R, w.Dir)
	if err != nil {
		return landed{}, err
	}
	if f.Base, err = LocalBase(ctx, g.R, t.Repo); err != nil {
		return landed{}, err
	}
	if err := f.compare(git, f.Base); err != nil {
		return landed{}, err
	}
	if missing := uncommitted(f, f.Base); len(missing) > 0 {
		return landed{bounce: strings.Join(missing, "；")}, nil
	}
	main := func(args ...string) (string, error) {
		out, err := g.R.Run(ctx, t.Repo, "git", args...)
		return strings.TrimSpace(out), err
	}
	baseHead, err := main("rev-parse", f.Base)
	if err != nil {
		return landed{}, err
	}
	fork, err := git("merge-base", f.Base, "HEAD")
	if err != nil {
		return landed{}, err
	}
	how := "快进"
	if fork != baseHead {
		how = "先合入 " + f.Base + " 再快进"
		if _, err := git("merge", "--no-edit", "--quiet", f.Base); err != nil {
			files, uerr := git("diff", "--name-only", "--diff-filter=U")
			if uerr != nil || files == "" {
				return landed{}, err
			}
			if _, err := git("merge", "--abort"); err != nil {
				return landed{}, err
			}
			return landed{bounce: fmt.Sprintf("合进本机 %s 有冲突（%s）：在分支 %s 上 git merge %s，解决冲突后提交",
				f.Base, strings.Join(firstN(strings.Fields(files), 10), "、"), f.Branch, f.Base)}, nil
		}
	}
	if _, err := main("merge", "--ff-only", "--quiet", f.Branch); err != nil {
		return landed{}, err
	}
	head, err := main("rev-parse", "HEAD")
	if err != nil {
		return landed{}, err
	}
	return landed{note: fmt.Sprintf("合进本机 %s（%s，%s）", f.Base, how, short(head))}, nil
}
