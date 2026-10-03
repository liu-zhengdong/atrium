package merge

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestCIJudge(t *testing.T) {
	pass := ciCheck{Name: "check", Bucket: "pass", Link: "https://ci/1"}
	fail := ciCheck{Name: "check", Bucket: "fail", Link: "https://ci/1"}
	cases := []struct {
		name    string
		checks  []ciCheck
		verdict ciVerdict
		red     ciCheck
	}{
		{"没有 checks", nil, ciEmpty, ciCheck{}},
		{"全过", []ciCheck{pass, {Name: "e2e", Bucket: "pass", Link: "https://ci/2"}}, ciGreen, ciCheck{}},
		{"跳过不算失败也不算在等", []ciCheck{pass, {Name: "win", Bucket: "skipping", Link: "https://ci/3"}}, ciGreen, ciCheck{}},
		{"有失败", []ciCheck{pass, fail}, ciRed, fail},
		{"取消按红", []ciCheck{{Name: "check", Bucket: "cancel", Link: "https://ci/1"}}, ciRed,
			ciCheck{Name: "check", Bucket: "cancel", Link: "https://ci/1"}},
		{"在等", []ciCheck{pass, {Name: "e2e", Bucket: "pending", Link: "https://ci/2"}}, ciPending, ciCheck{}},
		{"红优先于在等", []ciCheck{fail, {Name: "e2e", Bucket: "pending", Link: "https://ci/2"}}, ciRed, fail},
		{"认不得的结论按在等", []ciCheck{{Name: "check", Bucket: "queued", Link: "https://ci/1"}}, ciPending, ciCheck{}},
	}
	for _, c := range cases {
		verdict, red := ciJudge(c.checks)
		if verdict != c.verdict || red != c.red {
			t.Errorf("%s：得 %v %+v，要 %v %+v", c.name, verdict, red, c.verdict, c.red)
		}
	}
}

// CI 查询也可能卡住；使用同一 Runner 边界模拟实际 gh 的退出与上报时序。
type ciRunner func(context.Context) (string, error)

func (r ciRunner) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	return r(ctx)
}

func TestRunCIBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		replies                      []string
		queryErr                     error
		hang                         bool
		cancel                       bool
		pass, none, timeout, wantErr bool
	}{
		{name: "延迟上报后转绿", replies: []string{"[]", `[{"name":"test","bucket":"pending"}]`, `[{"name":"test","bucket":"pass"}]`}, pass: true},
		{name: "gh 无 checks 错误", queryErr: errors.New("no checks reported on the 'feat' branch"), pass: true, none: true},
		{name: "红 checks 非零退出仍解析", replies: []string{`[{"name":"test","bucket":"fail","link":"https://ci/red"}]`}, queryErr: errors.New("exit status 1")},
		{name: "查询错误不放行", queryErr: errors.New("authentication failed"), wantErr: true},
		{name: "查询卡住也超时", hang: true, timeout: true},
		{name: "服务取消不交回", hang: true, cancel: true, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			r := ciRunner(func(ctx context.Context) (string, error) {
				calls++
				if tc.hang {
					<-ctx.Done()
					return "", ctx.Err()
				}
				if len(tc.replies) == 0 {
					return "", tc.queryErr
				}
				i := calls - 1
				if i >= len(tc.replies) {
					i = len(tc.replies) - 1
				}
				return tc.replies[i], tc.queryErr
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancel {
				cancel()
			}
			out, err := runCI(ctx, &Queue{R: r, CIWait: 100 * time.Millisecond, CIReport: time.Millisecond}, "o/r", 1)
			if (err != nil) != tc.wantErr || out.Pass != tc.pass || out.None != tc.none || out.Timeout != tc.timeout {
				t.Fatalf("out=%+v err=%v", out, err)
			}
			if tc.name == "延迟上报后转绿" && calls != 3 {
				t.Fatalf("查询次数=%d", calls)
			}
			if tc.none && calls != 2 {
				t.Fatalf("无 checks 必须查询两次：%d", calls)
			}
			if tc.name == "红 checks 非零退出仍解析" && (out.Name != "test" || out.Link != "https://ci/red") {
				t.Fatalf("丢失失败详情：%+v", out)
			}
		})
	}
}
