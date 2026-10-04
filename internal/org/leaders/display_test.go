package leaders

import (
	"context"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// 隔离 HTTP 服务、临时名册与假执行者，经过实际唤醒拉起链路查看完整提示词。
func TestWakeIdentityDisplay(t *testing.T) {
	env, h, _ := fixture(t)
	ctx := context.Background()
	if err := events.Emit(ctx, env.DB, events.Event{Kind: events.TaskAssigned, Task: "t1", Dept: "o2", Target: "a2", Level: events.Act, Body: map[string]string{"title": "在 o2", "from": "a1"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.DB.Exec(`INSERT INTO hosts(id,name,kind,created_at) VALUES ('h3','ggb','remote',0)`); err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"h3", "h99"} {
		if err := events.Emit(ctx, env.DB, events.Event{Kind: events.Overdue, Task: "t1", Dept: "o2", Target: "a2", Level: events.Act, Body: map[string]any{"host": host, "text": "执行者在做（" + host + "）", "note": "用户原文 h3", "next": "atrium task show t1"}}); err != nil {
			t.Fatal(err)
		}
	}
	f := &fakeLauncher{h: h, db: env.DB, ack: true, cmd: "exit 0"}
	SetLauncher(f.launch)
	t.Cleanup(func() { SetLauncher(nil) })
	if err := h.round(ctx, env); err != nil {
		t.Fatal(err)
	}
	h.wg.Wait()
	if len(f.seen) != 1 {
		t.Fatalf("唤醒次数 %d", len(f.seen))
	}
	l := f.seen[0]
	for _, want := range []string{`"host":"ggb"`, "执行者在做（ggb）", `"host":"h99"`, "执行者在做（h99）", `"note":"用户原文 h3"`} {
		if !strings.Contains(l.Prompt, want) {
			t.Fatalf("唤醒提示词缺少 %s：%s", want, l.Prompt)
		}
	}
	for _, line := range strings.Split(l.Prompt, "\n") {
		if strings.Contains(line, "执行者在做") {
			t.Log(line)
		}
	}
	var original string
	if err := env.DB.QueryRow(`SELECT body FROM events WHERE id = 2`).Scan(&original); err != nil || !strings.Contains(original, `"host":"h3"`) {
		t.Fatalf("事件原文被改：%s %v", original, err)
	}
	for _, line := range strings.Split(l.Prompt, "\n") {
		if strings.HasPrefix(line, "你是 ") || strings.HasPrefix(line, "## 上报") || strings.HasPrefix(line, "3. 退出") || strings.HasPrefix(line, "2. 处理完确认") || strings.Contains(line, `"title":"在 o2"`) {
			t.Log(line)
		}
	}
	for _, want := range []string{"负责人 运行时（a2）", "发给 总部（a1）", "转交 总部（a1）", `{"from":"a1","title":"在 o2"}`, "2. 处理完确认：atrium events ack 1 2 3\n"} {
		if !strings.Contains(l.Prompt, want) {
			t.Errorf("提示词缺 %q", want)
		}
	}
	if l.Leader != "a2" {
		t.Errorf("拉起身份被格式化：%q", l.Leader)
	}
	// 已读的旧身份不能成为名字来源；改名后重新读名册。
	who, err := org.GetIdentity(ctx, env.DB, "a2")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.DB.ExecContext(ctx, `UPDATE identities SET name = ? WHERE id = ?`, "新名<&>\n（组）", "a2"); err != nil {
		t.Fatal(err)
	}
	p, err := buildPrompt(ctx, env.DB, who, []int64{1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(p, "负责人 新名<&>\n（组）（a2）") {
		t.Fatal("没有使用当前名册")
	}
	name, err := org.NameOf(ctx, env.DB, "a2")
	if err != nil || name != "新名<&>\n（组）" {
		t.Fatalf("NameOf 语义改变：%q %v", name, err)
	}
	if _, err := env.DB.ExecContext(ctx, `UPDATE departments SET leader = NULL WHERE leader = ?`, "a1"); err != nil {
		t.Fatal(err)
	}
	if _, err := env.DB.ExecContext(ctx, `DELETE FROM identities WHERE id = ?`, "a1"); err != nil {
		t.Fatal(err)
	}
	roster, err := org.Leaders(ctx, env.DB)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]string{}
	for _, identity := range roster {
		names[identity.ID] = identity.Name
	}
	if org.DisplayIdentity("a1", names) != "未登记负责人（a1）" {
		t.Fatal("已删除身份猜用了旧名")
	}
	name, err = org.NameOf(ctx, env.DB, "a1")
	if err != nil || name != "a1" {
		t.Fatalf("NameOf 未知语义改变：%q %v", name, err)
	}
}
