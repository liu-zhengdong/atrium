package hosts

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
)

func TestHelloDuringLaunch(t *testing.T) {
	for _, cancelLaunch := range []bool{false, true} {
		t.Run(map[bool]string{false: "回执", true: "取消"}[cancelLaunch], func(t *testing.T) {
			g := newRig(t)
			a, stop, done := g.agent(t.TempDir())
			stop()
			<-done
			g.task("t1")
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			go func() {
				_, _, _, err := Launch(ctx, g.env, a.Cfg.Host, Assignment{Task: "t1", Log: filepath.Join(t.TempDir(), "run.log")})
				result <- err
			}()
			commands := theHub.take(ctx, a.Cfg.Host, 5*time.Second)
			if len(commands) != 1 {
				t.Fatalf("指令：%+v", commands)
			}
			client := &api.Client{Base: g.server.URL, Token: a.Cfg.Token}
			if err := client.Do(ctx, "POST", "/api/agent/hello", map[string]any{"runs": []AgentRun{}}, nil); err != nil {
				t.Fatal(err)
			}
			row, err := getRun(ctx, g.env.DB, "t1")
			if err != nil || row.Exited || row.PID != 0 {
				t.Fatalf("未回执被收尾：%+v %v", row, err)
			}
			if cancelLaunch {
				cancel()
				if err := <-result; !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			} else {
				theHub.ack(Ack{ID: commands[0].ID, OK: true, PID: 4242})
				if err := <-result; err != nil {
					t.Fatal(err)
				}
				if err := client.Do(ctx, "POST", "/api/agent/hello", map[string]any{"runs": []AgentRun{}}, nil); err != nil {
					t.Fatal(err)
				}
			}
			if e := waitExit(t, g.env, "t1", 1); !e.Lost || e.Code != nil {
				t.Fatalf("退出：%+v", e)
			}
		})
	}
}

func TestRecoverLaunches(t *testing.T) {
	g := newRig(t)
	g.task("t1")
	g.task("t2")
	if _, err := g.env.DB.Exec(`INSERT INTO host_runs (task, host, run, pid, log_file, started_at) VALUES ('t1','h2',1,0,'x',0), ('t2','h2',1,4242,'x',0)`); err != nil {
		t.Fatal(err)
	}
	if err := RecoverLaunches(context.Background(), g.env.DB); err != nil {
		t.Fatal(err)
	}
	if e := waitExit(t, g.env, "t1", 1); !e.Lost {
		t.Fatalf("%+v", e)
	}
	row, err := getRun(context.Background(), g.env.DB, "t2")
	if err != nil || row.Exited {
		t.Fatalf("已回执不应收尾：%+v %v", row, err)
	}
}
