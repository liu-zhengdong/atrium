package pause

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestPaused(t *testing.T) {
	cases := []struct {
		name   string
		active []string
		scope  Scope
		want   bool
	}{
		{"没有暂停", nil, Scope{Orgs: []string{"o1"}, Host: "h1"}, false},
		{"全局", []string{"all"}, Scope{}, true},
		{"本部门", []string{"o2"}, Scope{Orgs: []string{"o1", "o2"}}, true},
		{"上级部门", []string{"o1"}, Scope{Orgs: []string{"o1", "o2", "o5"}}, true},
		{"别的部门", []string{"o3"}, Scope{Orgs: []string{"o1", "o2"}}, false},
		{"本机器", []string{"h2"}, Scope{Orgs: []string{"o1"}, Host: "h2"}, true},
		{"别的机器", []string{"h3"}, Scope{Host: "h2"}, false},
		{"没机器的动作不受机器暂停影响", []string{"h2"}, Scope{Orgs: []string{"o1"}}, false},
	}
	for _, c := range cases {
		if got := Paused(c.active, c.scope); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

func TestValidScope(t *testing.T) {
	for _, ok := range []string{"all", "o1", "h12"} {
		if ValidScope(ok) != nil {
			t.Errorf("%s 应合法", ok)
		}
	}
	for _, bad := range []string{"", "t1", "o", "o0", "O1", "o1x", "../o1"} {
		if ValidScope(bad) == nil {
			t.Errorf("%q 应拒绝", bad)
		}
	}
}

func TestStore(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	p := &Store{DB: db}
	if err := p.Set(ctx, "o2", "u1"); err != nil {
		t.Fatal(err)
	}
	if err := p.Set(ctx, "o2", "u1"); err != nil {
		t.Fatal("重复暂停应无害", err)
	}
	if got, _ := p.Paused(ctx, Scope{Orgs: []string{"o1", "o2"}}); !got {
		t.Fatal("应暂停")
	}
	if was, _ := p.Clear(ctx, "o2"); !was {
		t.Fatal("应报原先在暂停")
	}
	if got, _ := p.Paused(ctx, Scope{Orgs: []string{"o1", "o2"}}); got {
		t.Fatal("应已恢复")
	}
}
