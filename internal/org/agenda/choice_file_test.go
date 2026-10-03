package agenda

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

func TestChoiceRequiresReadableFile(t *testing.T) {
	for _, entry := range []string{"AddChoice", "Settle"} {
		for _, broken := range []string{"missing", "directory"} {
			t.Run(entry+"/"+broken, func(t *testing.T) {
				env, dept := setup(t)
				ctx := context.Background()
				m, err := org.AddMaterial(ctx, env.DB, env.Paths.Data, org.MaterialInput{Org: dept, Note: "实际文件反例", Files: []org.MaterialFile{{Name: "报告.md", Content: []byte("可读报告")}}}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "调研", Org: dept}, "u1")
				if err != nil {
					t.Fatal(err)
				}
				_, path, err := m.File("报告.md")
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if broken == "directory" {
					if err := os.Mkdir(path, 0o700); err != nil {
						t.Fatal(err)
					}
				}
				if _, _, err := m.ReadFile("报告.md"); err == nil {
					t.Fatal("故意破坏后实际文件仍可读")
				}
				var metadata int
				if err := env.DB.QueryRow(`SELECT count(*) FROM material_files WHERE id = ? AND path = ?`, m.ID, "报告.md").Scan(&metadata); err != nil || metadata != 1 {
					t.Fatalf("元数据应仍在：%d %v", metadata, err)
				}
				in := sample(3)
				in.Org = dept
				in.Options[1].Evidence = "文字说明 [报告](" + m.ID + "/%E6%8A%A5%E5%91%8A.md#preview)"
				create := func() (string, error) {
					if entry == "AddChoice" {
						c, err := AddChoice(ctx, env.DB, env.Paths.Data, in, "", "a1")
						return c.ID, err
					}
					raw, err := json.Marshal(in)
					if err != nil {
						t.Fatal(err)
					}
					c, err := Settle(ctx, env.DB, env.Paths.Data, task.ID, raw)
					if err != nil {
						return "", err
					}
					return c.ID, nil
				}
				if _, err := create(); code(err) != "usage" || !strings.Contains(err.Error(), "options[2].evidence") {
					t.Errorf("实际文件不可取得应拒绝第二项：%v", err)
				}
				for _, query := range []string{
					`SELECT count(*) FROM choices`,
					`SELECT count(*) FROM choice_options`,
					`SELECT count(*) FROM choice_option_orgs`,
					`SELECT count(*) FROM events WHERE kind = 'choice.open'`,
					`SELECT coalesce((SELECT last FROM ids WHERE prefix = 'c'), 0)`,
				} {
					var n int
					if err := env.DB.QueryRow(query).Scan(&n); err != nil || n != 0 {
						t.Errorf("拒绝后不得写入或占号：%s = %d (%v)", query, n, err)
					}
				}
				if broken == "directory" {
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				}
				if err := os.WriteFile(path, []byte("可读报告"), 0o600); err != nil {
					t.Fatal(err)
				}
				if id, err := create(); err != nil || id != "c1" {
					t.Fatalf("修复文件后第一张合法单必须为 c1：%s %v", id, err)
				}
			})
		}
	}
}
