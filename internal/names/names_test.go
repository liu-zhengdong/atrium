package names

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestLoadCurrentNames(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "names.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO hosts(id,name,kind,created_at) VALUES ('h3','ggb','remote',0)`); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"ggb", "新机器名", "h3"} {
		if want == "新机器名" {
			_, err = db.Exec(`UPDATE hosts SET name = ? WHERE id = ?`, want, "h3")
		}
		if want == "h3" {
			_, err = db.Exec(`DELETE FROM hosts WHERE id = ?`, "h3")
		}
		if err != nil {
			t.Fatal(err)
		}
		names, err := Load(context.Background(), db)
		if err != nil {
			t.Fatal(err)
		}
		if got := Host("h3", names); got != want {
			t.Fatalf("%q != %q", got, want)
		}
	}
}

func TestMachinePresentation(t *testing.T) {
	names := map[string]string{"h3": "ggb", "h4": " ", "h5": "长名字\n第二行"}
	for id, want := range map[string]string{"h3": "ggb", "h99": "h99", "h4": "h4", "h5": "长名字 第二行", "": ""} {
		if got := Host(id, names); got != want {
			t.Errorf("%s: %q != %q", id, got, want)
		}
	}
	for _, body := range []string{`invalid`, `[]`, `null`, `{"note":"用户原文（h3）","next":"atrium host ls h3","host":123}`} {
		if got := EventBody("overdue", body, names); got != body {
			t.Errorf("正文被改：%s", got)
		}
	}
	if got := HostText("等你回话：机器（h3）", names); got != "等你回话：机器（h3）" {
		t.Fatal(got)
	}
	body := `{"host":"h3","text":"执行者在做（h3）","note":"用户（h3）"}`
	got := EventBody("overdue", body, names)
	if !strings.Contains(got, `"host":"ggb"`) || !strings.Contains(got, "执行者在做（ggb）") || !strings.Contains(got, "用户（h3）") {
		t.Fatal(got)
	}
	if got := EventBody("task.status", body, names); !strings.Contains(got, "执行者在做（h3）") {
		t.Fatal(got)
	}
}
