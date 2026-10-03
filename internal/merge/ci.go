package merge

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
)

// ciVerdict 是一轮远端 checks 的判定（纯函数）。
type ciVerdict int

const (
	ciEmpty   ciVerdict = iota // 没有任何已上报的 checks
	ciGreen                    // 全部出了结论且没有失败
	ciPending                  // 还有没出结论的
	ciRed                      // 有失败或被取消
)

// ciCheck 是远端一个 check 的结论（gh pr checks --json 的子集）。
type ciCheck struct {
	Name   string `json:"name"`
	Bucket string `json:"bucket"` // pass、fail、pending、skipping、cancel
	Link   string `json:"link"`
}

// ciJudge 判一轮 checks：有失败先按红交回，不等还在跑的；skipping 不算失败也不算在等；
// 认不得的结论按还在等——宁可超时交回，也不把认不得的红合进去。纯函数。
func ciJudge(checks []ciCheck) (ciVerdict, ciCheck) {
	var red ciCheck
	found, pending := false, false
	for _, c := range checks {
		switch c.Bucket {
		case "pass", "skipping":
		case "fail", "cancel":
			if !found {
				red, found = c, true
			}
		default: // pending 与认不得的结论
			pending = true
		}
	}
	switch {
	case len(checks) == 0:
		return ciEmpty, ciCheck{}
	case found:
		return ciRed, red
	case pending:
		return ciPending, ciCheck{}
	}
	return ciGreen, ciCheck{}
}

// ciOutcome 是等远端 CI 的结果；语义对齐 checkOutcome：只有 Pass 合得进去。
type ciOutcome struct {
	None    bool // 没有任何已上报的 checks：视为没配 CI
	Pass    bool
	Timeout bool          // 等满上限还没全部通过
	Limit   time.Duration // Timeout 时的上限（写进交回原因）
	Name    string        // 红时：失败的 check 名
	Link    string        // 红时：结论链接
}

// runCI 等该 PR 头提交的远端 checks 出结论：全绿才合；有失败或等满上限都交回。
// 头提交刚推上去时 checks 可能几秒后才上报：查一次为空就等 report 再查一次，仍为空视为没配 CI。
func runCI(ctx context.Context, q *Queue, repo string, pr int) (out ciOutcome, err error) {
	limit := q.CIWait
	if limit == 0 {
		limit = 15 * time.Minute
	}
	// 上限覆盖查询、上报等待和轮询；服务取消不应被当作 CI 超时交回。
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	defer func() {
		if parent.Err() != nil {
			out, err = ciOutcome{}, parent.Err()
		} else if ctx.Err() == context.DeadlineExceeded {
			out, err = ciOutcome{Timeout: true, Limit: limit}, nil
		}
	}()
	report := q.CIReport
	if report == 0 {
		report = 30 * time.Second
	}
	step := limit / 10
	if step > 2*time.Second {
		step = 2 * time.Second
	}
	checks, err := ciChecks(ctx, q.R, repo, pr)
	if err != nil {
		return ciOutcome{}, err
	}
	if len(checks) == 0 {
		select {
		case <-ctx.Done():
			return ciOutcome{}, ctx.Err()
		case <-time.After(report):
		}
		if checks, err = ciChecks(ctx, q.R, repo, pr); err != nil {
			return ciOutcome{}, err
		}
		if len(checks) == 0 {
			return ciOutcome{None: true, Pass: true}, nil
		}
	}
	for {
		verdict, red := ciJudge(checks)
		switch verdict {
		case ciGreen:
			return ciOutcome{Pass: true}, nil
		case ciRed:
			return ciOutcome{Name: red.Name, Link: red.Link}, nil
		}
		select {
		case <-ctx.Done():
			return ciOutcome{}, ctx.Err()
		case <-time.After(step):
		}
		if checks, err = ciChecks(ctx, q.R, repo, pr); err != nil {
			return ciOutcome{}, err
		}
	}
}

// ciChecks 查该 PR 头提交上已上报的 checks。gh 对有 checks 但没跑完的（退出码 8）与有失败的（退出码 1）
// 都照常输出 JSON，先按 JSON 解析；没有 checks 时 gh 报错而不给数组，按空列表处理（没配 CI）。
func ciChecks(ctx context.Context, r gates.Runner, repo string, pr int) ([]ciCheck, error) {
	out, err := r.Run(ctx, "", "gh", "pr", "checks", fmt.Sprint(pr), "-R", repo, "--json", "name,bucket,link")
	if err != nil {
		var checks []ciCheck
		if jsonErr := json.Unmarshal([]byte(out), &checks); jsonErr == nil {
			return checks, nil
		}
		if strings.Contains(err.Error(), "no checks reported on the '") {
			return nil, nil
		}
		return nil, err
	}
	var checks []ciCheck
	if err := json.Unmarshal([]byte(out), &checks); err != nil {
		return nil, fmt.Errorf("gh pr checks 输出不是 JSON：%w", err)
	}
	return checks, nil
}
