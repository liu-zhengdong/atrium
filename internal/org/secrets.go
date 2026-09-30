package org

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/platform"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 凭据：按「部门 + 名称」存，名称就是注入执行者时的环境变量名。值只在数据目录 secrets/<oN>/<名称>（0600），
// 不回显、不进日志与提示词；分派任务时按名称从任务部门往上找（SecretEnv），是执行者白名单环境之外的唯一例外。
const maxSecretValue = 16 << 10

var (
	secretNameRe     = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	reservedPrefixes = []string{"ATRIUM_", "CLAUDE_CODE_", "PI_", "HERDR_", "NODE_", "GIT_", "LD_", "DYLD_"}
	reservedNames    = map[string]bool{"CLAUDECODE": true, "BASH_ENV": true, "ENV": true}
)

// CheckSecretName 纯判定：大写环境变量名；执行者环境本来就有的（系统、代理、运行时标记）与会改变程序加载方式的前缀不许用。
func CheckSecretName(name string) error {
	if !secretNameRe.MatchString(name) {
		return api.Usage("凭据名 %q 不合法：大写字母开头，只含大写字母、数字、下划线，最多 64 个字符（如 TELEGRAM_BOT_TOKEN）", name)
	}
	for _, goos := range []string{"linux", "darwin", "windows"} {
		if _, ok := platform.WorkerEnv(goos, map[string]string{name: "x"})[name]; ok {
			return api.Usage("凭据名 %s 是执行者环境本来就有的变量，换个名字", name)
		}
	}
	if reservedNames[name] {
		return api.Usage("凭据名 %s 会改变程序行为，换个名字", name)
	}
	for _, p := range reservedPrefixes {
		if strings.HasPrefix(name, p) {
			return api.Usage("凭据名前缀 %s* 留给运行时或会改变程序加载方式，换个名字", p)
		}
	}
	return nil
}

type Secret struct {
	Org        string `json:"org"`
	Name       string `json:"name"`
	UpdatedAt  int64  `json:"updated_at"`
	LastUsedAt *int64 `json:"last_used_at,omitempty"`
}

// SetSecret 写或覆盖一个凭据（只有用户）。
func SetSecret(ctx context.Context, db *store.DB, data, dept, name string, value []byte) (Secret, error) {
	if err := CheckSecretName(name); err != nil {
		return Secret{}, err
	}
	value = bytes.TrimRight(value, "\r\n")
	if len(value) == 0 {
		return Secret{}, api.Usage("凭据值为空：从标准输入给值，如 printf %%s \"$TOKEN\" | atrium secret set %s %s", dept, name)
	}
	if len(value) > maxSecretValue {
		return Secret{}, api.Usage("凭据值 %d 字节，超过 %d KB；更大的东西放资料", len(value), maxSecretValue>>10)
	}
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := Get(ctx, tx, dept); err != nil {
			return err
		}
		var n, has int
		if err := tx.QueryRowContext(ctx, `SELECT count(*), COALESCE(sum(name = ?), 0) FROM secrets WHERE department = ?`,
			name, dept).Scan(&n, &has); err != nil {
			return err
		}
		if has == 0 && n >= MaxSecrets {
			return Full("secrets", dept, n)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO secrets (department, name, updated_at) VALUES (?, ?, ?)
			ON CONFLICT (department, name) DO UPDATE SET updated_at = excluded.updated_at`, dept, name, store.Now()); err != nil {
			return err
		}
		return writeFile(secretFile(data, dept, name), value, 0o600)
	})
	if err != nil {
		return Secret{}, err
	}
	return getSecret(ctx, db, dept, name)
}

func getSecret(ctx context.Context, q store.Querier, dept, name string) (Secret, error) {
	var s Secret
	var used sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT department, name, updated_at, last_used_at FROM secrets WHERE department = ? AND name = ?`,
		dept, name).Scan(&s.Org, &s.Name, &s.UpdatedAt, &used)
	if store.IsNotFound(err) {
		return Secret{}, api.NotFound("部门 %s 没有凭据 %s", dept, name).WithNext("atrium secret ls --node " + dept)
	}
	if used.Valid {
		s.LastUsedAt = &used.Int64
	}
	return s, err
}

// RemoveSecret 删一个凭据（只有用户）。
func RemoveSecret(ctx context.Context, db *store.DB, data, dept, name string) (Secret, error) {
	s, err := getSecret(ctx, db, dept, name)
	if err != nil {
		return Secret{}, err
	}
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM secrets WHERE department = ? AND name = ?`, dept, name); err != nil {
			return err
		}
		return os.Remove(secretFile(data, dept, name))
	})
	return s, err
}

// Secrets 列凭据（不含值）。dept 为空列全部；给了部门列它能用到的（自己的与上级的，近的盖远的）。
func Secrets(ctx context.Context, q store.Querier, dept string) ([]Secret, error) {
	if dept == "" {
		return listSecrets(ctx, q, `SELECT department, name, updated_at, last_used_at FROM secrets ORDER BY department, name LIMIT ?`,
			MaxDepts*MaxSecrets)
	}
	chain, err := Ancestors(ctx, q, dept)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	out := []Secret{}
	for i := len(chain) - 1; i >= 0; i-- {
		own, err := listSecrets(ctx, q, `SELECT department, name, updated_at, last_used_at FROM secrets WHERE department = ?
			ORDER BY name LIMIT ?`, chain[i], ReadCap+1)
		if err != nil {
			return nil, err
		}
		for _, s := range own {
			if !seen[s.Name] {
				seen[s.Name] = true
				out = append(out, s)
			}
		}
	}
	return out, nil
}

func listSecrets(ctx context.Context, q store.Querier, query string, args ...any) ([]Secret, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Secret{}
	for rows.Next() {
		var s Secret
		var used sql.NullInt64
		if err := rows.Scan(&s.Org, &s.Name, &s.UpdatedAt, &used); err != nil {
			return nil, err
		}
		if used.Valid {
			s.LastUsedAt = &used.Int64
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, capErr("凭据", len(out))
}

// SecretEnv 是分派任务时注入执行者的凭据：每个名称从任务部门往上找最近的一份，记下使用时间。
// 找不到就报错（带补上的命令），分派任务应停下而不是缺着凭据跑。
func SecretEnv(ctx context.Context, db *store.DB, data, dept string, names []string) (map[string]string, error) {
	if len(names) == 0 {
		return map[string]string{}, nil
	}
	if dept == "" {
		return nil, api.Usage("任务没挂部门，找不到凭据 %s", strings.Join(names, "、"))
	}
	chain, err := Ancestors(ctx, db, dept)
	if err != nil {
		return nil, err
	}
	env := map[string]string{}
	for _, name := range names {
		if err := CheckSecretName(name); err != nil {
			return nil, err
		}
		found := ""
		for i := len(chain) - 1; i >= 0 && found == ""; i-- {
			if _, err := getSecret(ctx, db, chain[i], name); err == nil {
				found = chain[i]
			} else if !isCode(err, "not_found") {
				return nil, err
			}
		}
		if found == "" {
			return nil, api.NotFound("凭据 %s 在部门 %s 及上级都没有", name, dept).
				WithNext(fmt.Sprintf("printf %%s \"$值\" | atrium secret set %s %s", dept, name))
		}
		raw, err := os.ReadFile(secretFile(data, found, name))
		if err != nil {
			return nil, fmt.Errorf("读凭据 %s（%s）失败：%w", name, found, errors.Unwrap(err))
		}
		env[name] = string(raw)
		if _, err := db.ExecContext(ctx, `UPDATE secrets SET last_used_at = ? WHERE department = ? AND name = ?`,
			store.Now(), found, name); err != nil {
			return nil, err
		}
	}
	return env, nil
}

type secretBody struct {
	Value string `json:"value"`
}

func secretRoutes(r *api.Router, env *app.Env) {
	db, data := env.DB, env.Paths.Data
	deptName := func(q *api.Req) (string, string, error) {
		dept, err := q.Ref("id", "o")
		return dept, q.PathValue("name"), err
	}
	r.Handle("GET /api/secrets", func(q *api.Req) (any, error) {
		if q.Actor.Kind != "user" && q.Actor.Kind != "leader" {
			return nil, api.Forbidden("%s 不能看凭据清单", q.Actor.ID)
		}
		return Secrets(q.Context(), db, q.URL.Query().Get("node"))
	})
	r.Handle("PUT /api/org/{id}/secrets/{name}", func(q *api.Req) (any, error) {
		if err := CheckUser(q.Actor, "设凭据"); err != nil {
			return nil, err
		}
		dept, name, err := deptName(q)
		if err != nil {
			return nil, err
		}
		var in secretBody
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		return SetSecret(q.Context(), db, data, dept, name, []byte(in.Value))
	})
	r.Handle("DELETE /api/org/{id}/secrets/{name}", func(q *api.Req) (any, error) {
		if err := CheckUser(q.Actor, "删凭据"); err != nil {
			return nil, err
		}
		dept, name, err := deptName(q)
		if err != nil {
			return nil, err
		}
		return RemoveSecret(q.Context(), db, data, dept, name)
	})
}

func secretCommands(t *cli.Table) {
	t.Group("secret", "凭据")
	t.Add(cli.Command{Path: "secret set", Args: "<oN> <名称>", Summary: "设部门的凭据：值从标准输入读（不写在命令行上）；--rm 删掉（只有用户）",
		Flags: []cli.Flag{{Name: "rm", Bool: true, Help: "删掉这个凭据"}},
		Run: func(c *cli.Ctx) error {
			dept, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			name, err := c.Arg(1, "<名称>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			if c.Bool("rm") {
				var s Secret
				if err := c.Call("DELETE", "/api/org/"+url.PathEscape(dept)+"/secrets/"+url.PathEscape(name), nil, &s); err != nil {
					return err
				}
				return c.Done(s, fmt.Sprintf("已删凭据 %s（%s）", s.Name, s.Org), "atrium secret ls --node "+s.Org)
			}
			raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxSecretValue+1))
			if err != nil {
				return err
			}
			var s Secret
			if err := c.Call("PUT", "/api/org/"+url.PathEscape(dept)+"/secrets/"+url.PathEscape(name), secretBody{string(raw)}, &s); err != nil {
				return err
			}
			return c.Done(s, fmt.Sprintf("已设凭据 %s（%s），值不显示", s.Name, s.Org),
				"atrium skill add <技能> --secrets "+s.Name)
		}})
	t.Add(cli.Command{Path: "secret ls", Summary: "列凭据名称（不含值）",
		Flags: []cli.Flag{{Name: "node", Value: "oN", Help: "只看这个部门能用到的（含上级的）"}},
		Run: func(c *cli.Ctx) error {
			var list []Secret
			if err := c.Call("GET", "/api/secrets?node="+url.QueryEscape(c.Str("node")), nil, &list); err != nil {
				return err
			}
			if len(list) == 0 {
				return c.Done(list, "没有凭据", "printf %s \"$值\" | atrium secret set <oN> <名称>")
			}
			var b strings.Builder
			for _, s := range list {
				used := "没用过"
				if s.LastUsedAt != nil {
					used = "最近用于 " + fmtTime(*s.LastUsedAt)
				}
				fmt.Fprintf(&b, "  %s  %s  %s\n", s.Org, s.Name, used)
			}
			return c.Done(list, b.String(), "atrium secret set <oN> <名称> --rm")
		}})
}
