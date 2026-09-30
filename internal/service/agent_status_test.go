package service

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/cli"
)

func TestStatusAgent(t *testing.T) {
	for _, tc := range []struct {
		name, pid, want string
		bad             bool
	}{
		{"运行", strconv.Itoa(os.Getpid()), "代理在运行", false},
		{"停止", "", "代理没在运行", false},
		{"失效进程", "99999999", "代理没在运行", false},
		{"坏登记", "broken", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "agent.json"), []byte(`{"token":"不得显示"}`), 0600); err != nil {
				t.Fatal(err)
			}
			if tc.pid != "" {
				if err := os.WriteFile(filepath.Join(dir, "agent.pid"), []byte(tc.pid), 0600); err != nil {
					t.Fatal(err)
				}
			}
			var out bytes.Buffer
			c := &cli.Ctx{Context: context.Background(), Env: cli.Env{Stdout: &out, Getenv: func(k string) string {
				if k == "ATRIUM_DATA" {
					return dir
				}
				return ""
			}}}
			err := status(c)
			if (err != nil) != tc.bad {
				t.Fatalf("err=%v", err)
			}
			if !tc.bad && (!strings.Contains(out.String(), tc.want) || !strings.Contains(out.String(), dir) || strings.Contains(out.String(), "不得显示")) {
				t.Fatal(out.String())
			}
		})
	}
}
