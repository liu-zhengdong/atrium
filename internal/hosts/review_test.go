package hosts

import (
	"context"
	"testing"
)

func TestReviewReusesTaskCapacity(t *testing.T) {
	g := newRig(t)
	ctx := context.Background()
	if err := EnsureLocal(ctx, g.env.DB, Info{MaxWorkers: 1, CLIs: map[string]CLI{"fake": {Installed: true}}}); err != nil {
		t.Fatal(err)
	}
	g.task("t1")
	if _, err := g.env.DB.ExecContext(ctx, `UPDATE tasks SET host = 'h1', stage = 'review' WHERE id = 't1'`); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ task, want string }{{"", "queue"}, {"t1", "run"}} {
		c, err := Pick(ctx, g.env, Need{Task: tc.task, Tool: "fake"}, Local)
		if err != nil || c.Kind != tc.want {
			t.Fatalf("task=%q：%+v %v，要求%s", tc.task, c, err, tc.want)
		}
	}
	// 别的任务仍占容量，不能借原任务的轮次突破上限。
	g.task("t2")
	if _, err := g.env.DB.ExecContext(ctx, `UPDATE tasks SET host = 'h1' WHERE id = 't2'`); err != nil {
		t.Fatal(err)
	}
	if c, err := Pick(ctx, g.env, Need{Task: "t1", Tool: "fake"}, Local); err != nil || c.Kind != "queue" {
		t.Fatalf("没有计入其他任务的容量：%+v %v", c, err)
	}
}
