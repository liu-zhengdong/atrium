package leaders

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func TestSubordinateStructureRoutes(t *testing.T) {
	env, h, srv := fixture(t)
	ctx := context.Background()
	t1, _ := h.issue("a1")
	t2, _ := h.issue("a2")
	a1 := &api.Client{Base: srv.URL, Token: t1}
	a2 := &api.Client{Base: srv.URL, Token: t2}
	user := &api.Client{Base: srv.URL, Token: "user"}
	for _, c := range []struct {
		name         string
		client       *api.Client
		method, path string
		body         any
	}{
		{"a1 直属 o1 建部门", a1, "POST", "/api/org", org.NewDept{Name: "坏", Parent: "o1"}},
		{"a1 继承直属区建部门", a1, "POST", "/api/org", org.NewDept{Name: "坏", Parent: "o4"}},
		{"a2 自己 o2 建部门", a2, "POST", "/api/org", org.NewDept{Name: "坏", Parent: "o2"}},
		{"登记不绑定", a1, "POST", "/api/leaders", org.NewLeader{Name: "坏"}},
	} {
		// o4 在下面先由用户建立，确保这条是没登记负责人的继承区域。
		if c.path == "/api/org" && c.name == "a1 继承直属区建部门" {
			if err := user.Do(ctx, "POST", "/api/org", org.NewDept{Name: "继承区", Parent: "o1"}, nil); err != nil {
				t.Fatal(err)
			}
		}
		err := c.client.Do(ctx, c.method, c.path, c.body, nil)
		var ae *api.Error
		if !errors.As(err, &ae) || ae.Code != "forbidden" || !strings.Contains(ae.Next, "--kind beyond") {
			t.Errorf("%s 应拒绝并提示上交：%v", c.name, err)
		}
	}
	var child org.Dept
	if err := a1.Do(ctx, "POST", "/api/org", org.NewDept{Name: "新分工", Parent: "o2"}, &child); err != nil {
		t.Fatal(err)
	}
	var leader org.Identity
	if err := a1.Do(ctx, "POST", "/api/leaders", org.NewLeader{Name: "下层", Dept: child.ID}, &leader); err != nil {
		t.Fatal(err)
	}
	if len(leader.Depts) != 1 || leader.Depts[0] != child.ID || len(leader.Workers) != 1 || leader.Workers[0] != "fake" {
		t.Fatalf("新负责人应一步绑定并沿用组合：%+v", leader)
	}
	t3, _ := h.issue(leader.ID)
	a3 := &api.Client{Base: srv.URL, Token: t3}
	if got := code(a3.Do(ctx, "POST", "/api/org", org.NewDept{Name: "坏", Parent: child.ID}, nil)); got != "forbidden" {
		t.Errorf("下层不能在自己直管的部门建：%s", got)
	}
	if got := code(a1.Do(ctx, "PATCH", "/api/org/"+child.ID, org.DeptPatch{Parent: ptr("o1")}, nil)); got != "forbidden" {
		t.Errorf("挪到下属区域外应拒绝：%s", got)
	}
	if _, err := org.SetMemo(ctx, env.DB, leader.ID, "待删", "u1"); err != nil {
		t.Fatal(err)
	}
	var replacement org.Identity
	if err := user.Do(ctx, "POST", "/api/leaders", org.NewLeader{Name: "接替", Workers: []string{"fake"}}, &replacement); err != nil {
		t.Fatal(err)
	}
	if err := a1.Do(ctx, "PATCH", "/api/org/"+child.ID, org.DeptPatch{Leader: &replacement.ID}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := org.GetIdentity(ctx, env.DB, leader.ID); code(err) != "not_found" {
		t.Errorf("旧负责人应连备忘删除：%v", err)
	}
	var n int
	if err := env.DB.QueryRowContext(ctx, `SELECT count(*) FROM memos WHERE identity = ?`, leader.ID).Scan(&n); err != nil || n != 0 {
		t.Fatalf("旧备忘未删：%d %v", n, err)
	}
	if err := a1.Do(ctx, "PATCH", "/api/org/"+child.ID, org.DeptPatch{Leader: ptr("-")}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := org.GetIdentity(ctx, env.DB, replacement.ID); code(err) != "not_found" {
		t.Errorf("清除后应删空身份：%v", err)
	}
	var merge org.Dept
	if err := a1.Do(ctx, "POST", "/api/org", org.NewDept{Name: "并入目标", Parent: "o2"}, &merge); err != nil {
		t.Fatal(err)
	}
	if got := code(a1.Do(ctx, "PATCH", "/api/org/"+child.ID, org.DeptPatch{Delete: true, Into: ptr("o1")}, nil)); got != "forbidden" {
		t.Errorf("并入下属区域外应拒绝：%s", got)
	}
	if err := a1.Do(ctx, "PATCH", "/api/org/"+child.ID, org.DeptPatch{Delete: true, Into: &merge.ID}, nil); err != nil {
		t.Fatalf("下属区域内并入应放行：%v", err)
	}
}

func TestDirectLeaderLimitRoute(t *testing.T) {
	env, _, srv := fixture(t)
	ctx := context.Background()
	user := &api.Client{Base: srv.URL, Token: "user"}
	for n := 0; n < 7; n++ {
		var dept org.Dept
		if err := user.Do(ctx, "POST", "/api/org", org.NewDept{Name: fmt.Sprintf("分工%d", n), Parent: "o1"}, &dept); err != nil {
			t.Fatal(err)
		}
		var leader org.Identity
		err := user.Do(ctx, "POST", "/api/leaders", org.NewLeader{Name: "下层", Workers: []string{"fake"}, Dept: dept.ID}, &leader)
		want := "ok"
		if n == 6 {
			want = "limit"
		} // 已有 a2，加六位正好七位
		if got := code(err); got != want {
			t.Fatalf("第 %d 位：%s，应为 %s", n+2, got, want)
		}
	}
	counts, err := org.Counts(ctx, env.DB, "o1")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range counts {
		if c.Key == "direct_leaders" && c.Used == 7 && c.Max == 7 {
			found = true
		}
	}
	if !found {
		t.Errorf("上限用量应可见 7/7：%+v", counts)
	}
}

func ptr(s string) *string { return &s }
