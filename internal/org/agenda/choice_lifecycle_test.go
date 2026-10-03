package agenda

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestSettleRequiresMaterialForEveryOption(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "调研", Org: dept}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	for _, evidence := range []string{"对比图与动效预览里 01 列", "m1", "m999/22.svg", "m1/22.svg"} {
		in := sample(3)
		in.Options[1].Evidence = evidence
		raw, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Settle(ctx, env.DB, task.ID, raw); code(err) != "usage" || !strings.Contains(err.Error(), "options[2].evidence") {
			t.Fatalf("%s: %v", evidence, err)
		}
		var choices, events, lastID int
		env.DB.QueryRow(`SELECT count(*) FROM choices`).Scan(&choices)
		env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = 'choice.open'`).Scan(&events)
		env.DB.QueryRow(`SELECT coalesce((SELECT last FROM ids WHERE prefix = 'c'), 0)`).Scan(&lastID)
		if choices != 0 || events != 0 || lastID != 0 {
			t.Fatalf("拒绝后留下选项单、事件或占号：%d %d %d", choices, events, lastID)
		}
	}
}

func TestEvidenceRefs(t *testing.T) {
	for _, tc := range []struct {
		text string
		want []string
	}{
		{"自由文字：对比图里 01 列", nil},
		{"来自 m12，见 `m12/images/22.svg`。", []string{"m12", "m12/images/22.svg"}},
		{"[对比](m2/index.html)，m3/图片.png", []string{"m2/index.html", "m3/图片.png"}},
		{"https://localhost/ui/material/m4/a.png", []string{"m4/a.png"}},
		{"item12、m12abc、m1_name", nil},
	} {
		if got := evidenceRefs(tc.text); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%q: %v != %v", tc.text, got, tc.want)
		}
	}
}

func TestChoicePickVoidRace(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		in := sample(3)
		in.Org = dept
		c, err := AddChoice(ctx, env.DB, in, "", "a1")
		if err != nil {
			t.Fatal(err)
		}
		var pickErr, voidErr error
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; _, pickErr = Decide(ctx, env.DB, c.ID, []int{1}, "", "u1") }()
		go func() { defer wg.Done(); <-start; _, voidErr = Void(ctx, env.DB, c.ID, "被替代", "a1") }()
		close(start)
		wg.Wait()
		c, err = GetChoice(ctx, env.DB, c.ID)
		if err != nil {
			t.Fatal(err)
		}
		if c.Status == "void" {
			if code(pickErr) != "conflict" || voidErr != nil || c.Options[0].Task != "" {
				t.Fatalf("作废却建任务: %+v %v %v", c, pickErr, voidErr)
			}
		} else if c.Status != "picked" || pickErr != nil || code(voidErr) != "conflict" || c.Options[0].Task == "" {
			t.Fatalf("竞争结果: %+v %v %v", c, pickErr, voidErr)
		}
	}
}

func TestChoiceEvidenceAndVoid(t *testing.T) {
	env, dept := setup(t)
	ctx := context.Background()
	m, err := org.AddMaterial(ctx, env.DB, t.TempDir(), org.MaterialInput{Org: dept, Note: "22 号参考图，选项依据验证", Files: []org.MaterialFile{{Name: "22.svg", Content: []byte("<svg/>")}}}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	in := sample(3)
	in.Org = dept
	for _, ref := range []string{"对比图与动效预览里 01 列", "m1", "m1/#preview", "m1/?download=1", "m999/image.png", m.ID + "/missing.svg", m.ID + "/../22.svg", "先看 " + m.ID + "/22.svg，再看 m999/image.png"} {
		in.Options[1].Evidence = ref
		if _, err := AddChoice(ctx, env.DB, in, "", "a1"); code(err) != "usage" || !strings.Contains(err.Error(), "options[2].evidence") {
			t.Fatalf("%s: %v", ref, err)
		}
	}
	list, err := Choices(ctx, env.DB, dept, true)
	if err != nil || len(list) != 0 {
		t.Fatalf("拒绝后不得留单: %v %v", list, err)
	}
	in.Options[1].Evidence = "[图](" + m.ID + "/22.svg#preview)"
	c, err := AddChoice(ctx, env.DB, in, "", "a1")
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != "c1" {
		t.Fatalf("拒绝后占号：%s", c.ID)
	}
	if _, err := Void(ctx, env.DB, c.ID, " ", "a1"); code(err) != "usage" {
		t.Fatal(err)
	}
	c, err = Void(ctx, env.DB, c.ID, "27 看岔了，实际选的是 22", "a1")
	if err != nil || c.Status != "void" || c.DecidedAt == nil || Unpicked(c) != "" {
		t.Fatalf("作废: %+v %v", c, err)
	}
	if text := choiceText(c); !strings.Contains(text, "已作废：") || strings.Contains(text, "用户说明") || strings.Contains(text, "这轮没选") {
		t.Fatal(text)
	}
	list, err = Choices(ctx, env.DB, dept, false)
	if err != nil || len(list) != 0 {
		t.Fatalf("作废仍等拍板: %v %v", list, err)
	}
	var pending, tasks int
	env.DB.QueryRow(`SELECT count(*) FROM events WHERE kind = 'choice.open' AND acked_at IS NULL`).Scan(&pending)
	env.DB.QueryRow(`SELECT count(*) FROM tasks`).Scan(&tasks)
	if pending != 0 || tasks != 0 {
		t.Fatalf("pending=%d tasks=%d", pending, tasks)
	}
	goals, err := ledger.ReadGoals(ctx, env.DB, store.Now())
	if err != nil || goals.All.Offered != 0 || goals.Week.Offered != 0 {
		t.Fatalf("作废计入认可率: %+v %v", goals, err)
	}
	if hist, err := recentUnpicked(ctx, env.DB, dept); err != nil || len(hist) != 0 {
		t.Fatalf("作废计入未选历史: %v %v", hist, err)
	}
	for _, picks := range [][]int{nil, {1}} {
		if _, err := Decide(ctx, env.DB, c.ID, picks, "", "u1"); code(err) != "conflict" {
			t.Fatal(err)
		}
	}
	if _, err := Void(ctx, env.DB, c.ID, "再作废", "a1"); code(err) != "conflict" {
		t.Fatal(err)
	}
	in.Options[1].Evidence = "无法解析的自由文字也能建立"
	if _, err := AddChoice(ctx, env.DB, in, "", "a1"); code(err) != "usage" {
		t.Fatalf("无引用必须拒绝：%v", err)
	}
}
