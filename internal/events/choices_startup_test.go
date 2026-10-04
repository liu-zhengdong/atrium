package events_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/service"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 使用真实服务入口与事件、选项单模块；不装配执行者和额度读取。
func TestChoicesDegradedService(t *testing.T) {
	for _, kind := range []string{"unknown", "decision", "empty-decision"} {
		t.Run(kind, func(t *testing.T) {
			paths := config.Paths{Data: t.TempDir()}
			db, err := store.Open(paths.DB())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO departments(id,name,created_at,updated_at) VALUES('o1','隔离',1,1);
INSERT INTO identities(id,kind,name,created_at) VALUES('a1','leader','负责人',1);
UPDATE departments SET leader='a1' WHERE id='o1';`); err != nil {
				t.Fatal(err)
			}
			ddl := `CREATE TABLE choices(id TEXT PRIMARY KEY, unknown TEXT)`
			insert := `INSERT INTO choices VALUES('c1','保留')`
			if kind != "unknown" {
				if err := db.QueryRow(`SELECT sql FROM sqlite_schema WHERE name='choices'`).Scan(&ddl); err != nil {
					t.Fatal(err)
				}
				ddl = strings.Replace(ddl, "'passed', 'void'", "'passed'", 1)
				ddl = strings.Replace(ddl, "  created_by", "  decision TEXT REFERENCES decisions (id),\n  created_by", 1)
				insert = `INSERT INTO choices(id,department,title,recommend,reason,status,decision,created_by,created_at) VALUES('c1','o1','保留','1','理由','open','d1','a1',1)`
				if kind == "empty-decision" {
					insert = strings.Replace(insert, "'d1'", "NULL", 1)
				}
			}
			// 历史 decision 指向的表已不在现行 schema；夹具写入时关闭外键。
			if _, err := db.Exec(`PRAGMA foreign_keys=OFF; DROP TABLE choices; ` + ddl + `; ` + insert); err != nil {
				t.Fatal(err)
			}
			db.Close()
			done := make(chan error, 1)
			go func() {
				done <- service.Serve([]app.Module{events.Module(), agenda.Module()}, func(key string) string {
					switch key {
					case "ATRIUM_DATA":
						return paths.Data
					case "ATRIUM_PORT":
						return "0"
					}
					return ""
				})
			}()
			// 每个隔离服务独占连接池，避免共享 DefaultTransport 的连接留到下一轮。
			transport := &http.Transport{}
			t.Cleanup(transport.CloseIdleConnections)
			client := &http.Client{Timeout: 5 * time.Second, Transport: transport}
			var info config.ServiceInfo
			deadline := time.Now().Add(5 * time.Second)
			for {
				info, err = config.ReadService(paths)
				if err == nil {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("服务提前退出：%v", err)
				default:
				}
				if time.Now().After(deadline) {
					t.Fatal("服务未就绪")
				}
				time.Sleep(10 * time.Millisecond)
			}
			token, err := config.ReadToken(paths)
			if err != nil {
				t.Fatal(err)
			}
			base := fmt.Sprintf("http://127.0.0.1:%d", info.Port)
			call := func(method, path string) *http.Response {
				t.Helper()
				req, err := http.NewRequest(method, base+path, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Authorization", "Bearer "+token)
				res, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				return res
			}
			t.Cleanup(func() {
				res := call("POST", "/api/service/stop")
				io.Copy(io.Discard, res.Body)
				res.Body.Close()
				// 先结束测试客户端的连接，再等服务排空；不延长停机超时。
				transport.CloseIdleConnections()
				select {
				case err := <-done:
					if err != nil {
						t.Error(err)
					}
				case <-time.After(5 * time.Second):
					t.Error("隔离服务未停止")
				}
			})
			res := call("GET", "/health")
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if res.StatusCode != 200 {
				t.Fatal(res.Status)
			}
			timeout := "2"
			if kind == "empty-decision" {
				timeout = "0"
			}
			res = call("GET", "/api/events/wait?as=a1&timeout="+timeout)
			var receipt struct {
				OK     bool         `json:"ok"`
				Result []events.Row `json:"result"`
			}
			err = json.NewDecoder(res.Body).Decode(&receipt)
			io.Copy(io.Discard, res.Body)
			res.Body.Close()
			expected := 1
			if kind == "empty-decision" {
				expected = 0
			}
			if err != nil || !receipt.OK || len(receipt.Result) != expected {
				t.Fatalf("事件未送达：%+v %v", receipt, err)
			}
			if expected == 1 {
				row := receipt.Result[0]
				if row.Kind != events.ChoicesUpgradeSkipped || row.Level != events.Act || !strings.Contains(string(row.Body), paths.DB()) {
					t.Fatal(row)
				}
			}
			db, err = store.Open(paths.DB())
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var value string
			column := "unknown"
			if kind == "empty-decision" {
				column = "title"
				if db.ChoicesSkipped != nil {
					t.Fatal("空 decision 没有迁移")
				}
				if _, err := db.Exec(`UPDATE choices SET status='void' WHERE id='c1'`); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "decision" {
				column = "decision"
			}
			if err := db.QueryRow(`SELECT ` + column + ` FROM choices WHERE id='c1'`).Scan(&value); err != nil || value == "" {
				t.Fatal(value, err)
			}
			t.Logf("隔离 HTTP 服务启动；负责人收到 %d 条 act 事件；数据保留", expected)
		})
	}
}
