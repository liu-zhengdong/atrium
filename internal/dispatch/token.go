package dispatch

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 执行者令牌：每次拉起签发一枚，本机与远程的执行者都凭它用命令行连回服务（环境变量 ATRIUM_SERVER、ATRIUM_WORKER_TOKEN）。
// 令牌是 wt_<任务>_<第几次拉起>_<签名>，签名是以用户令牌为钥匙的 HMAC：不存库，服务重启后照样认，轮换用户令牌后全部作废。
// 只在这次拉起还在跑时有效（WorkerLive），执行者退出、任务转交付或重派就失效。能做什么见 WorkerRule。

// workerToken 签发任务 task 第 n 次拉起的令牌。
func workerToken(key, task string, n int) string {
	return fmt.Sprintf("wt_%s_%d_%s", task, n, workerMAC(key, task, n))
}

func workerMAC(key, task string, n int) string {
	m := hmac.New(sha256.New, []byte(key))
	fmt.Fprintf(m, "worker/%s/%d", task, n)
	return hex.EncodeToString(m.Sum(nil))
}

// parseWorkerToken 纯函数：拆出任务与第几次拉起，并核对签名。
func parseWorkerToken(key, token string) (task string, n int, ok bool) {
	rest, ok := strings.CutPrefix(token, "wt_")
	parts := strings.Split(rest, "_")
	if !ok || len(parts) != 3 || !api.IsRef(parts[0], "t") {
		return "", 0, false
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil || n < 1 || !hmac.Equal([]byte(parts[2]), []byte(workerMAC(key, parts[0], n))) {
		return "", 0, false
	}
	return parts[0], n, true
}

// WorkerLive 纯判定：第 n 次拉起的令牌此刻是否有效。lastN 是账上最近一次拉起（没有为 0）。
// 这次拉起已记录结果：任务在跑、不在交付阶段、最近一次就是它；拉起到记录结果之间（进程已起、还没记 launch）
// 账上还是上一次，n = lastN+1 也认——那一枚只签发给正在拉起的这个进程。
func WorkerLive(status ledger.Status, stage ledger.Stage, lastN, n int) bool {
	if n == lastN+1 {
		return true
	}
	return n == lastN && status == ledger.Running && stage == ledger.StageNone
}

// WorkerAccess 是执行者令牌碰到一条路由时的规则。
type WorkerAccess int

const (
	WorkerDeny     WorkerAccess = iota
	WorkerRead                  // 只读接口：执行者能跑的看、列、取
	WorkerMaterial              // 加资料（新建或给 mN 加一版）：只能加到本任务所在的部门
	WorkerTaskNote              // 写任务备注：只能写自己在做的任务
)

// WorkerRule 纯判定：执行者令牌碰到这条路由（Go 路由模式）时的规则。默认拒绝。
// 只读放行 GET，但不含服务与令牌操作、事件（取事件会占租约，执行者不是订阅者）。
func WorkerRule(pattern string) WorkerAccess {
	method, path, _ := strings.Cut(pattern, " ")
	for _, p := range []string{"/api/service", "/api/auth", "/api/events"} {
		if path == p || strings.HasPrefix(path, p+"/") {
			return WorkerDeny
		}
	}
	switch {
	case !strings.HasPrefix(path, "/api/"):
		return WorkerDeny
	case method == "GET" || method == "HEAD":
		return WorkerRead
	case method == "POST" && (path == "/api/materials" || path == "/api/materials/{id}/revs"):
		return WorkerMaterial
	case method == "POST" && path == "/api/tasks/{id}/notes":
		return WorkerTaskNote
	}
	return WorkerDeny
}

// WorkerMaterialCheck 纯判定：执行者往 dept 加资料。taskOrg 是它的任务所在部门。
func WorkerMaterialCheck(task, taskOrg, dept string, overview bool) error {
	switch {
	case taskOrg == "":
		return api.Forbidden("%s 不属于任何部门，执行者加不了资料", task)
	case dept != taskOrg:
		return api.Forbidden("执行者只能往本任务所在的部门（%s）加资料，收到 %s", taskOrg, dept).
			WithNext("atrium material add " + taskOrg + " <文件或目录> --note <是什么>")
	case overview:
		return api.Forbidden("部门总览由负责人维护，执行者只加细节资料")
	}
	return nil
}

// workerActor 是执行者令牌的身份：署名写「tN 执行者」。
func workerActor(task string) api.Actor { return api.Actor{ID: task + " 执行者", Kind: "worker"} }

// workerTask 从执行者身份取回任务号。
func workerTask(a api.Actor) string { t, _, _ := strings.Cut(a.ID, " "); return t }

// issueWorkerToken 给任务 task 第 n 次拉起签发令牌。
func issueWorkerToken(env *app.Env, task string, n int) (string, error) {
	key, err := config.ReadToken(env.Paths)
	if err != nil {
		return "", err
	}
	return workerToken(key, task, n), nil
}

// authWorker 认执行者令牌：签名对、这次拉起还在跑。
func authWorker(env *app.Env) api.Authenticator {
	return func(token string) (api.Actor, bool) {
		if !strings.HasPrefix(token, "wt_") {
			return api.Actor{}, false
		}
		key, err := config.ReadToken(env.Paths)
		if err != nil {
			return api.Actor{}, false
		}
		task, n, ok := parseWorkerToken(key, token)
		if !ok {
			return api.Actor{}, false
		}
		ctx := context.Background()
		t, err := ledger.Get(ctx, env.DB, task)
		if err != nil {
			return api.Actor{}, false
		}
		last, err := workers.LastRun(ctx, env.DB, task)
		if err != nil {
			return api.Actor{}, false
		}
		lastN := 0
		if last != nil {
			lastN = last.N
		}
		if !WorkerLive(t.Status, t.Stage, lastN, n) {
			return api.Actor{}, false
		}
		return workerActor(task), true
	}
}

// workerGuard 是执行者令牌的统一权限判定：按 WorkerRule 取规则，加资料再查部门，写备注再查是不是本任务。
func workerGuard(env *app.Env) api.Guard {
	return func(q *api.Req) error {
		switch WorkerRule(q.Pattern) {
		case WorkerRead:
			return nil
		case WorkerMaterial:
			var in struct {
				Org      string `json:"org"`
				Overview bool   `json:"overview"`
			}
			if err := q.Peek(&in, org.MaxMaterialBody); err != nil {
				return err
			}
			// 给 mN 加一版：部门与类别看那条资料。
			if id := q.PathValue("id"); id != "" {
				m, err := org.GetMaterial(q.Context(), env.DB, env.Paths.Data, id, 0)
				if err != nil {
					return err
				}
				in.Org, in.Overview = m.Org, m.Kind == "overview"
			}
			task := workerTask(q.Actor)
			t, err := ledger.Get(q.Context(), env.DB, task)
			if err != nil {
				return err
			}
			return WorkerMaterialCheck(task, t.Org, in.Org, in.Overview)
		case WorkerTaskNote:
			if task := workerTask(q.Actor); q.PathValue("id") != task {
				return api.Forbidden("执行者只能给自己在做的任务（%s）写备注", task).
					WithNext("atrium task note " + task + " <文字>")
			}
			return nil
		}
		return api.Forbidden("执行者不能调 %s：执行者只能看、取资料、往本任务所在部门加资料、给自己在做的任务写备注；要改别的，写进交付说明", q.Pattern)
	}
}
